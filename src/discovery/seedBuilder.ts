import type { Prisma, PrismaClient, Track } from "@prisma/client";

import {
  getProviderIdForClientTrack,
  getProviderTrackIdForClientTrack,
  toExternalTrackId,
} from "../tracks/service";
import { trackDurationToMilliseconds } from "../tracks/duration";
import { ingestTrack } from "./ingestion/ingestTrack";

type DbClient = PrismaClient | Prisma.TransactionClient;

export async function ensureCanonicalTrackForLegacyTrack(prisma: DbClient, track: Track) {
  const existing = await prisma.trackSource.findUnique({
    where: {
      legacyTrackId: track.id,
    },
    include: {
      canonicalTrack: {
        include: {
          artists: true,
        },
      },
    },
  });

  if (existing) {
    return existing.canonicalTrack;
  }

  const ingested = await ingestTrack(prisma, {
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

  return prisma.canonicalTrack.findUniqueOrThrow({
    where: {
      id: ingested.canonicalTrack.id,
    },
    include: {
      artists: true,
    },
  });
}
