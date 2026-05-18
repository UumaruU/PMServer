import type { Prisma, PrismaClient } from "@prisma/client";

import { getProviderPriority, getProviderTrustScore } from "../../recommendation/providers/sourceRegistry";
import { durationMillisecondsToClientSeconds } from "../../tracks/duration";
import type { ExternalTrack } from "../providers/provider.types";
import type { IngestedTrack } from "../discovery.types";
import { deduplicateTrack } from "./deduplicateTrack";
import { ingestArtist } from "./ingestArtist";
import { normalizeExternalTrack } from "./normalizeExternalTrack";
import {
  buildFreshnessPatch,
  keepBestIndexStatus,
  resolveCanonicalIndexStatus,
  resolveSourceIndexStatus,
} from "./qualityGates";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface IngestTrackInput {
  track: ExternalTrack;
  legacyTrackId?: string | null;
  clientTrackId?: string | null;
  discoveredFrom?: string | null;
}

function mergeTags(left: string[], right: string[]) {
  return [...new Set([...left, ...right].map((tag) => tag.trim()).filter(Boolean))];
}

function buildLegacyTrackData(normalized: NonNullable<ReturnType<typeof normalizeExternalTrack>>, clientTrackId: string) {
  return {
    clientTrackId,
    source: normalized.providerId,
    sourceTrackId: normalized.sourceTrackId,
    title: normalized.title,
    artistName: normalized.artistName,
    albumTitle: normalized.albumTitle,
    duration: durationMillisecondsToClientSeconds(normalized.durationMs),
    coverUrl: normalized.coverUrl,
    audioUrl: normalized.audioUrl,
    musicBrainzRecordingId: normalized.musicBrainzRecordingId,
    musicBrainzArtistId: normalized.musicBrainzArtistId,
    musicBrainzReleaseId: normalized.musicBrainzReleaseId,
  };
}

async function upsertLegacyPlayableTrack(params: {
  prisma: Prisma.TransactionClient;
  normalized: NonNullable<ReturnType<typeof normalizeExternalTrack>>;
  clientTrackId: string;
}) {
  const data = buildLegacyTrackData(params.normalized, params.clientTrackId);
  const existingBySource = await params.prisma.track.findUnique({
    where: {
      source_sourceTrackId: {
        source: data.source,
        sourceTrackId: data.sourceTrackId,
      },
    },
  });
  const existingByClientTrackId = await params.prisma.track.findUnique({
    where: {
      clientTrackId: data.clientTrackId,
    },
  });
  const existing = existingBySource ?? existingByClientTrackId;

  if (existing) {
    const canClaimClientTrackId = !existingByClientTrackId || existingByClientTrackId.id === existing.id;
    const canClaimSource = !existingBySource || existingBySource.id === existing.id;

    return params.prisma.track.update({
      where: {
        id: existing.id,
      },
      data: {
        ...(canClaimClientTrackId ? { clientTrackId: data.clientTrackId } : {}),
        ...(canClaimSource ? { source: data.source, sourceTrackId: data.sourceTrackId } : {}),
        title: data.title,
        artistName: data.artistName,
        albumTitle: data.albumTitle,
        duration: data.duration,
        coverUrl: data.coverUrl,
        audioUrl: data.audioUrl,
        musicBrainzRecordingId: data.musicBrainzRecordingId,
        musicBrainzArtistId: data.musicBrainzArtistId,
        musicBrainzReleaseId: data.musicBrainzReleaseId,
      },
    });
  }

  return params.prisma.track.create({
    data,
  });
}

async function upsertTrackSource(params: {
  prisma: Prisma.TransactionClient;
  canonicalTrackId: string;
  legacyTrackId: string | null;
  clientTrackId: string;
  normalized: NonNullable<ReturnType<typeof normalizeExternalTrack>>;
  sourceTrust: number;
  sourcePriority: number;
  matchConfidence: number;
  discoveredFrom?: string | null;
}) {
  const qualityScore = Math.max(params.normalized.qualityScore, params.sourceTrust * 0.75) + params.sourcePriority / 1000;
  const indexStatus = resolveSourceIndexStatus({
    isPlayable: params.normalized.isPlayable,
    qualityScore,
    matchConfidence: params.matchConfidence,
    sourceTrust: params.sourceTrust,
  });
  const freshnessPatch = buildFreshnessPatch({
    now: new Date(),
    isPlayable: params.normalized.isPlayable,
    qualityScore,
    sourceTrust: params.sourceTrust,
  });
  const existingByProviderSource = await params.prisma.trackSource.findUnique({
    where: {
      providerId_sourceTrackId: {
        providerId: params.normalized.providerId,
        sourceTrackId: params.normalized.sourceTrackId,
      },
    },
  });
  const existingByClientTrackId = await params.prisma.trackSource.findUnique({
    where: {
      clientTrackId: params.clientTrackId,
    },
  });
  const existingByLegacyTrackId = params.legacyTrackId
    ? await params.prisma.trackSource.findUnique({
        where: {
          legacyTrackId: params.legacyTrackId,
        },
      })
    : null;
  const existing = existingByProviderSource ?? existingByClientTrackId ?? existingByLegacyTrackId;
  const sourceData = {
    canonicalTrackId: params.canonicalTrackId,
    legacyTrackId: params.legacyTrackId,
    clientTrackId: params.clientTrackId,
    providerId: params.normalized.providerId,
    sourceTrackId: params.normalized.sourceTrackId,
    title: params.normalized.title,
    artistName: params.normalized.artistName,
    albumTitle: params.normalized.albumTitle,
    durationMs: params.normalized.durationMs,
    coverUrl: params.normalized.coverUrl,
    audioUrl: params.normalized.audioUrl,
    sourceUrl: params.normalized.sourceUrl,
    musicBrainzRecordingId: params.normalized.musicBrainzRecordingId,
    musicBrainzArtistId: params.normalized.musicBrainzArtistId,
    musicBrainzReleaseId: params.normalized.musicBrainzReleaseId,
    musicBrainzReleaseGroupId: params.normalized.musicBrainzReleaseGroupId,
    isrc: params.normalized.isrc,
    tags: params.normalized.tags,
    isPlayable: params.normalized.isPlayable,
    qualityScore,
    matchConfidence: params.matchConfidence,
    indexStatus,
    discoveredFrom: params.discoveredFrom ?? null,
    ...freshnessPatch,
  };

  if (existing) {
    const canClaimProviderSource = !existingByProviderSource || existingByProviderSource.id === existing.id;
    const canClaimClientTrackId = !existingByClientTrackId || existingByClientTrackId.id === existing.id;
    const canClaimLegacyTrackId = !existingByLegacyTrackId || existingByLegacyTrackId.id === existing.id;

    return params.prisma.trackSource.update({
      where: {
        id: existing.id,
      },
      data: {
        canonicalTrackId: sourceData.canonicalTrackId,
        ...(canClaimLegacyTrackId ? { legacyTrackId: sourceData.legacyTrackId } : {}),
        ...(canClaimClientTrackId ? { clientTrackId: sourceData.clientTrackId } : {}),
        ...(canClaimProviderSource ? { providerId: sourceData.providerId, sourceTrackId: sourceData.sourceTrackId } : {}),
        title: sourceData.title,
        artistName: sourceData.artistName,
        albumTitle: sourceData.albumTitle,
        durationMs: sourceData.durationMs,
        coverUrl: sourceData.coverUrl,
        audioUrl: sourceData.audioUrl,
        sourceUrl: sourceData.sourceUrl,
        musicBrainzRecordingId: sourceData.musicBrainzRecordingId,
        musicBrainzArtistId: sourceData.musicBrainzArtistId,
        musicBrainzReleaseId: sourceData.musicBrainzReleaseId,
        musicBrainzReleaseGroupId: sourceData.musicBrainzReleaseGroupId,
        isrc: sourceData.isrc,
        tags: sourceData.tags,
        isPlayable: sourceData.isPlayable,
        qualityScore: sourceData.qualityScore,
        matchConfidence: sourceData.matchConfidence,
        indexStatus: sourceData.indexStatus,
        discoveredFrom: sourceData.discoveredFrom ?? undefined,
        lastIndexedAt: sourceData.lastIndexedAt,
        lastProviderCheckAt: sourceData.lastProviderCheckAt,
        lastSeenAt: sourceData.lastSeenAt,
        metadataFreshness: sourceData.metadataFreshness,
        playableSourceFreshness: sourceData.playableSourceFreshness,
      },
    });
  }

  return params.prisma.trackSource.create({
    data: sourceData,
  });
}

async function ingestTrackInTransaction(prisma: Prisma.TransactionClient, input: IngestTrackInput): Promise<IngestedTrack> {
  const normalized = normalizeExternalTrack(input.track);

  if (!normalized) {
    throw new Error("Cannot ingest an empty or invalid external track.");
  }

  const deduplication = await deduplicateTrack(prisma, normalized);
  const artist = await ingestArtist(prisma, {
    providerId: normalized.providerId,
    sourceArtistId: normalized.musicBrainzArtistId ?? normalized.normalizedArtistCore,
    name: normalized.artistName,
    musicBrainzArtistId: normalized.musicBrainzArtistId,
    tags: normalized.tags,
  });
  const sourceTrust = getProviderTrustScore(normalized.providerId);
  const sourcePriority = getProviderPriority(normalized.providerId);
  const existing = await prisma.canonicalTrack.findUnique({
    where: {
      id: deduplication.canonicalTrackId,
    },
  });
  const canonicalQualityScore = Math.max(normalized.qualityScore, sourceTrust * 0.8);
  const canonicalIndexStatus = resolveCanonicalIndexStatus({
    isPlayable: normalized.isPlayable,
    qualityScore: canonicalQualityScore,
    matchConfidence: deduplication.matchConfidence,
    sourceTrust,
  });
  const canonicalFreshnessPatch = buildFreshnessPatch({
    now: new Date(),
    isPlayable: normalized.isPlayable,
    qualityScore: canonicalQualityScore,
    sourceTrust,
  });

  const canonicalTrack = await prisma.canonicalTrack.upsert({
    where: {
      id: deduplication.canonicalTrackId,
    },
    create: {
      id: deduplication.canonicalTrackId,
      title: normalized.title,
      artistName: normalized.artistName,
      albumTitle: normalized.albumTitle,
      normalizedTitle: normalized.normalizedTitleCore,
      normalizedArtist: normalized.normalizedArtistCore,
      durationMs: normalized.durationMs,
      coverUrl: normalized.coverUrl,
      releaseDate: normalized.releaseDate,
      musicBrainzRecordingId: normalized.musicBrainzRecordingId,
      musicBrainzArtistId: normalized.musicBrainzArtistId,
      musicBrainzReleaseId: normalized.musicBrainzReleaseId,
      musicBrainzReleaseGroupId: normalized.musicBrainzReleaseGroupId,
      isrc: normalized.isrc,
      titleFlavor: normalized.titleFlavor,
      tags: normalized.tags,
      qualityScore: canonicalQualityScore,
      matchConfidence: deduplication.matchConfidence,
      indexStatus: canonicalIndexStatus,
      discoveredFrom: input.discoveredFrom ?? null,
      ...canonicalFreshnessPatch,
      artists: {
        connect: {
          id: artist.id,
        },
      },
    },
    update: {
      title: existing && existing.qualityScore > normalized.qualityScore ? existing.title : normalized.title,
      artistName: existing && existing.qualityScore > normalized.qualityScore ? existing.artistName : normalized.artistName,
      albumTitle: normalized.albumTitle ?? existing?.albumTitle ?? null,
      durationMs: normalized.durationMs ?? existing?.durationMs ?? null,
      coverUrl: normalized.coverUrl ?? existing?.coverUrl ?? null,
      releaseDate: normalized.releaseDate ?? existing?.releaseDate ?? null,
      musicBrainzRecordingId: normalized.musicBrainzRecordingId ?? existing?.musicBrainzRecordingId ?? null,
      musicBrainzArtistId: normalized.musicBrainzArtistId ?? existing?.musicBrainzArtistId ?? null,
      musicBrainzReleaseId: normalized.musicBrainzReleaseId ?? existing?.musicBrainzReleaseId ?? null,
      musicBrainzReleaseGroupId: normalized.musicBrainzReleaseGroupId ?? existing?.musicBrainzReleaseGroupId ?? null,
      isrc: normalized.isrc ?? existing?.isrc ?? null,
      titleFlavor: mergeTags(existing?.titleFlavor ?? [], normalized.titleFlavor),
      tags: mergeTags(existing?.tags ?? [], normalized.tags),
      qualityScore: Math.max(existing?.qualityScore ?? 0, canonicalQualityScore),
      matchConfidence: Math.max(existing?.matchConfidence ?? 0, deduplication.matchConfidence),
      indexStatus: keepBestIndexStatus(existing?.indexStatus, canonicalIndexStatus),
      discoveredFrom: existing?.discoveredFrom ?? input.discoveredFrom ?? null,
      ...canonicalFreshnessPatch,
      artists: {
        connect: {
          id: artist.id,
        },
      },
    },
  });

  const clientTrackId = input.clientTrackId ?? `${normalized.providerId}:${normalized.sourceTrackId}`;
  let legacyTrackId = input.legacyTrackId ?? null;
  if (!legacyTrackId && normalized.isPlayable) {
    const legacyTrack = await upsertLegacyPlayableTrack({
      prisma,
      normalized,
      clientTrackId,
    });
    legacyTrackId = legacyTrack.id;
  }

  const source = await upsertTrackSource({
    prisma,
    canonicalTrackId: canonicalTrack.id,
    legacyTrackId,
    clientTrackId,
    normalized,
    sourceTrust,
    sourcePriority,
    matchConfidence: deduplication.matchConfidence,
    discoveredFrom: input.discoveredFrom,
  });

  return {
    canonicalTrack,
    source,
  };
}

export async function ingestTrack(prisma: DbClient, input: IngestTrackInput): Promise<IngestedTrack> {
  if ("$transaction" in prisma) {
    return prisma.$transaction((transaction) => ingestTrackInTransaction(transaction, input));
  }

  return ingestTrackInTransaction(prisma, input);
}
