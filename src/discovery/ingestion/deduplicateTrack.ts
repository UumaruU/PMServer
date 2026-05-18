import type { Prisma } from "@prisma/client";

import type { NormalizedExternalTrack } from "../discovery.types";

type DbClient = Prisma.TransactionClient;

function createDeterministicHash(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0).toString(16);
}

function flavorsCompatible(left: string[], right: string[]) {
  const normalizedLeft = left.filter((flavor) => flavor !== "original").sort().join("|");
  const normalizedRight = right.filter((flavor) => flavor !== "original").sort().join("|");
  return normalizedLeft === normalizedRight;
}

export async function deduplicateTrack(prisma: DbClient, track: NormalizedExternalTrack) {
  if (track.musicBrainzRecordingId) {
    return {
      canonicalTrackId: `mbrec:${track.musicBrainzRecordingId}`,
      matchConfidence: 0.98,
    };
  }

  if (track.isrc) {
    return {
      canonicalTrackId: `isrc:${track.isrc}`,
      matchConfidence: 0.94,
    };
  }

  const existingSource = await prisma.trackSource.findUnique({
    where: {
      providerId_sourceTrackId: {
        providerId: track.providerId,
        sourceTrackId: track.sourceTrackId,
      },
    },
  });

  if (existingSource) {
    return {
      canonicalTrackId: existingSource.canonicalTrackId,
      matchConfidence: Math.max(existingSource.matchConfidence, 0.9),
    };
  }

  const softMatches = await prisma.canonicalTrack.findMany({
    where: {
      normalizedTitle: track.normalizedTitleCore,
      normalizedArtist: track.normalizedArtistCore,
    },
    take: 10,
  });
  const match = softMatches.find((candidate) => {
    const candidateDuration = candidate.durationMs ?? 0;
    const trackDuration = track.durationMs ?? 0;
    const durationCompatible =
      !candidateDuration || !trackDuration || Math.abs(candidateDuration - trackDuration) <= 7_000;

    return durationCompatible && flavorsCompatible(candidate.titleFlavor, track.titleFlavor);
  });

  if (match) {
    return {
      canonicalTrackId: match.id,
      matchConfidence: 0.72,
    };
  }

  const durationBucket = track.durationMs ? Math.round(track.durationMs / 2_000) : 0;
  return {
    canonicalTrackId: `soft:${createDeterministicHash(
      [track.normalizedTitleCore, track.normalizedArtistCore, durationBucket, track.titleFlavor.sort().join("|")].join("|"),
    )}`,
    matchConfidence: track.matchConfidence,
  };
}
