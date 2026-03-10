import type { Prisma, PrismaClient, Track } from "@prisma/client";

import { AppError } from "../utils/errors";

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

export const toExternalTrackId = (track: Pick<Track, "id" | "source" | "sourceTrackId">): string =>
  track.source === SYNC_TRACK_SOURCE ? track.sourceTrackId : track.id;

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
      source_sourceTrackId: {
        source: SYNC_TRACK_SOURCE,
        sourceTrackId: normalizedTrackId,
      },
    },
    create: {
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
    update: {},
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
