import type { Prisma, PrismaClient, Track } from "@prisma/client";

import { ingestTrack } from "../discovery/ingestion/ingestTrack";
import { AppError } from "../utils/errors";
import { trackDurationToMilliseconds } from "./duration";

type DbClient = PrismaClient | Prisma.TransactionClient;

export const SYNC_TRACK_SOURCE = "client-sync";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

export const ensureTrackExists = async (prisma: DbClient, trackId: string): Promise<Track> => {
  const track = await prisma.track.findUnique({
    where: {
      id: trackId,
    },
  });

  if (!track) {
    throw new AppError(404, "TRACK_NOT_FOUND", "Track not found.");
  }

  return track;
};

function normalizeRequired(value: string, code: string, message: string) {
  const normalized = value.trim();

  if (!normalized) {
    throw new AppError(400, code, message);
  }

  return normalized;
}

function normalizeOptional(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function buildClientTrackId(input: {
  clientTrackId?: string | null;
  source: string;
  sourceTrackId: string;
}) {
  return normalizeOptional(input.clientTrackId) ?? `${input.source}:${input.sourceTrackId}`;
}

export function getProviderIdForClientTrack(track: { clientTrackId?: string | null; source: string }) {
  if (track.source && track.source !== SYNC_TRACK_SOURCE) {
    return track.source;
  }

  const clientTrackId = normalizeOptional(track.clientTrackId);
  if (!clientTrackId || !clientTrackId.includes(":")) {
    return "hitmos";
  }

  return clientTrackId.split(":")[0] || "hitmos";
}

export function getProviderTrackIdForClientTrack(
  track: { clientTrackId?: string | null; sourceTrackId: string },
) {
  const clientTrackId = normalizeOptional(track.clientTrackId);

  if (clientTrackId && clientTrackId.includes(":")) {
    return clientTrackId.slice(clientTrackId.indexOf(":") + 1) || track.sourceTrackId;
  }

  return track.sourceTrackId;
}

export const toExternalTrackId = (
  track: { clientTrackId?: string | null; source: string; sourceTrackId: string },
): string => normalizeOptional(track.clientTrackId) ?? (track.source === SYNC_TRACK_SOURCE ? track.sourceTrackId : `${track.source}:${track.sourceTrackId}`);

export interface ResolvedTrackInput {
  clientTrackId?: string | null;
  source: string;
  sourceTrackId: string;
  title: string;
  artistName: string;
  albumTitle?: string | null;
  duration?: number | null;
  coverUrl?: string | null;
  audioUrl?: string | null;
  musicBrainzRecordingId?: string | null;
  musicBrainzArtistId?: string | null;
  musicBrainzReleaseId?: string | null;
}

function toResolvedTrackData(input: ResolvedTrackInput) {
  const source = normalizeRequired(input.source, "INVALID_TRACK_SOURCE", "Track source is required.");
  const sourceTrackId = normalizeRequired(
    input.sourceTrackId,
    "INVALID_SOURCE_TRACK_ID",
    "Track source ID is required.",
  );
  const title = normalizeRequired(input.title, "INVALID_TRACK_TITLE", "Track title is required.");
  const artistName = normalizeRequired(
    input.artistName,
    "INVALID_TRACK_ARTIST",
    "Track artist is required.",
  );

  return {
    clientTrackId: buildClientTrackId({
      clientTrackId: input.clientTrackId,
      source,
      sourceTrackId,
    }),
    source,
    sourceTrackId,
    title,
    artistName,
    albumTitle: normalizeOptional(input.albumTitle),
    duration: typeof input.duration === "number" && Number.isFinite(input.duration) ? Math.max(0, Math.round(input.duration)) : null,
    coverUrl: normalizeOptional(input.coverUrl),
    audioUrl: normalizeOptional(input.audioUrl),
    musicBrainzRecordingId: normalizeOptional(input.musicBrainzRecordingId),
    musicBrainzArtistId: normalizeOptional(input.musicBrainzArtistId),
    musicBrainzReleaseId: normalizeOptional(input.musicBrainzReleaseId),
  };
}

async function ingestResolvedTrackSource(prisma: DbClient, track: Track) {
  try {
    await ingestTrack(prisma, {
      legacyTrackId: track.id,
      clientTrackId: toExternalTrackId(track),
      track: {
        providerId: getProviderIdForClientTrack(track),
        sourceTrackId: getProviderTrackIdForClientTrack(track),
        title: track.title,
        artistName: track.artistName,
        albumTitle: track.albumTitle,
        durationMs: trackDurationToMilliseconds(track.duration),
        coverUrl: track.coverUrl,
        audioUrl: track.audioUrl,
        sourceUrl: track.audioUrl,
        musicBrainzRecordingId: track.musicBrainzRecordingId,
        musicBrainzArtistId: track.musicBrainzArtistId,
        musicBrainzReleaseId: track.musicBrainzReleaseId,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Cannot ingest an empty or invalid external track.") {
      return;
    }

    throw error;
  }
}

export async function upsertResolvedTrack(prisma: DbClient, input: ResolvedTrackInput): Promise<Track> {
  const data = toResolvedTrackData(input);
  const existingByClientTrackId = data.clientTrackId
    ? await prisma.track.findUnique({
        where: {
          clientTrackId: data.clientTrackId,
        },
      })
    : null;

  if (existingByClientTrackId) {
    const track = await prisma.track.update({
      where: {
        id: existingByClientTrackId.id,
      },
      data,
    });
    await ingestResolvedTrackSource(prisma, track);
    return track;
  }

  const existingBySource = await prisma.track.findUnique({
    where: {
      source_sourceTrackId: {
        source: data.source,
        sourceTrackId: data.sourceTrackId,
      },
    },
  });

  if (existingBySource) {
    const track = await prisma.track.update({
      where: {
        id: existingBySource.id,
      },
      data,
    });
    await ingestResolvedTrackSource(prisma, track);
    return track;
  }

  const track = await prisma.track.create({
    data,
  });
  await ingestResolvedTrackSource(prisma, track);
  return track;
}

export async function upsertResolvedTracks(
  prisma: DbClient,
  tracks: ResolvedTrackInput[],
): Promise<Track[]> {
  const uniqueTracks = new Map<string, ResolvedTrackInput>();

  tracks.forEach((track) => {
    const source = track.source?.trim();
    const sourceTrackId = track.sourceTrackId?.trim();

    if (!source || !sourceTrackId) {
      return;
    }

    const key = buildClientTrackId({
      clientTrackId: track.clientTrackId,
      source,
      sourceTrackId,
    });

    uniqueTracks.set(key, {
      ...track,
      source,
      sourceTrackId,
    });
  });

  const results: Track[] = [];
  for (const track of uniqueTracks.values()) {
    results.push(await upsertResolvedTrack(prisma, track));
  }
  return results;
}

export const ensureSyncTrack = async (
  prisma: DbClient,
  externalTrackId: string,
): Promise<Track> => {
  const normalizedTrackId = externalTrackId.trim();

  if (!normalizedTrackId) {
    throw new AppError(400, "INVALID_TRACK_ID", "Track ID is required.");
  }

  if (isUuid(normalizedTrackId)) {
    const internalTrack = await prisma.track.findUnique({
      where: {
        id: normalizedTrackId,
      },
    });

    if (internalTrack) {
      return internalTrack;
    }
  }

  return prisma.track.upsert({
    where: {
      clientTrackId: normalizedTrackId,
    },
    create: {
      clientTrackId: normalizedTrackId,
      source: SYNC_TRACK_SOURCE,
      sourceTrackId: normalizedTrackId,
      title: normalizedTrackId,
      artistName: "Unknown Artist",
      albumTitle: null,
      duration: null,
      coverUrl: null,
      audioUrl: null,
      musicBrainzRecordingId: null,
      musicBrainzArtistId: null,
      musicBrainzReleaseId: null,
    },
    update: {
      clientTrackId: normalizedTrackId,
      source: SYNC_TRACK_SOURCE,
      sourceTrackId: normalizedTrackId,
    },
  });
};

export const ensureSyncTracks = async (
  prisma: DbClient,
  externalTrackIds: string[],
): Promise<Map<string, Track>> => {
  const uniqueIds = [...new Set(externalTrackIds.map((trackId) => trackId.trim()).filter(Boolean))];
  const trackEntries = await Promise.all(
    uniqueIds.map(async (externalTrackId) => [externalTrackId, await ensureSyncTrack(prisma, externalTrackId)] as const),
  );

  return new Map(trackEntries);
};

export const findTrackByClientTrackId = async (
  prisma: DbClient,
  clientTrackId: string,
): Promise<Track | null> => {
  const normalizedTrackId = clientTrackId.trim();

  if (!normalizedTrackId) {
    return null;
  }

  return prisma.track.findUnique({
    where: {
      clientTrackId: normalizedTrackId,
    },
  });
};
