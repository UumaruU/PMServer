import {
  RecommendationCandidate,
  RecommendationCatalogSnapshot,
  RecommendationChannel,
  RecommendationConfig,
  RecommendationContext,
  RecommendationProfiles,
  RecommendationSeed,
} from "../types";

function compareLexical(left: string, right: string) {
  return left.localeCompare(right);
}

function pushCandidate(
  bag: Map<string, RecommendationCandidate>,
  canonicalTrackId: string,
  channel: RecommendationChannel,
  weight: number,
  evidence: Record<string, unknown>,
) {
  const existing = bag.get(canonicalTrackId);
  if (existing) {
    existing.sourceChannels = [...new Set([...existing.sourceChannels, channel])].sort(compareLexical);
    existing.channelWeights[channel] = Math.max(existing.channelWeights[channel] ?? 0, weight);
    existing.mergedEvidence.push(evidence);
    existing.baseScore += weight;
    return;
  }

  bag.set(canonicalTrackId, {
    canonicalTrackId,
    sourceChannels: [channel],
    channelWeights: { [channel]: weight },
    mergedEvidence: [evidence],
    baseScore: weight,
  });
}

function topAffinityKeys(entries: Record<string, { value: number }>, limit: number) {
  return Object.entries(entries)
    .sort((left, right) => {
      if (left[1].value !== right[1].value) {
        return right[1].value - left[1].value;
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([key]) => key);
}

// Pure domain logic: candidate generation only uses canonical snapshot, profiles and deterministic ordering.
export function generateCandidates(params: {
  seed: RecommendationSeed;
  context: RecommendationContext;
  snapshot: RecommendationCatalogSnapshot;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const { seed, context, snapshot, profiles, config } = params;
  const candidates = new Map<string, RecommendationCandidate>();
  const currentTrack =
    (context.currentCanonicalTrackId && snapshot.tracksById[context.currentCanonicalTrackId]) ||
    (seed.canonicalTrackId && snapshot.tracksById[seed.canonicalTrackId]) ||
    null;

  if (currentTrack?.primaryCanonicalArtistId) {
    const sameArtistTracks = snapshot.artistToTracks[currentTrack.primaryCanonicalArtistId] ?? [];
    sameArtistTracks
      .filter((trackId) => trackId !== currentTrack.canonicalTrackId)
      .slice(0, config.candidatePoolSizes.sameArtist)
      .forEach((trackId) =>
        pushCandidate(candidates, trackId, "sameArtist", 1.2, {
          currentArtistId: currentTrack.primaryCanonicalArtistId,
        }),
      );

    (snapshot.artistRelations[currentTrack.primaryCanonicalArtistId] ?? [])
      .slice(0, config.candidatePoolSizes.frequentCollaborators)
      .forEach((edge) => {
        (snapshot.artistToTracks[edge.rightId] ?? []).forEach((trackId) => {
          pushCandidate(candidates, trackId, "frequentCollaborators", edge.weight, {
            collaboratorArtistId: edge.rightId,
          });
        });
      });

    (snapshot.relatedArtists[currentTrack.primaryCanonicalArtistId] ?? [])
      .slice(0, config.candidatePoolSizes.relatedArtists)
      .forEach((edge) => {
        (snapshot.artistToTracks[edge.rightId] ?? []).forEach((trackId) => {
          pushCandidate(candidates, trackId, "relatedArtists", edge.weight, {
            relatedArtistId: edge.rightId,
          });
        });
      });
  }

  currentTrack?.tagIds.slice(0, config.candidatePoolSizes.sharedTags).forEach((tagId) => {
    (snapshot.tagToTracks[tagId] ?? []).forEach((trackId) => {
      if (trackId !== currentTrack.canonicalTrackId) {
        pushCandidate(candidates, trackId, "sharedTags", currentTrack.tagWeights[tagId] ?? 1, { tagId });
      }
    });
  });

  if (currentTrack?.canonicalReleaseId) {
    (snapshot.releaseToTracks[currentTrack.canonicalReleaseId] ?? [])
      .filter((trackId) => trackId !== currentTrack.canonicalTrackId)
      .slice(0, config.candidatePoolSizes.releaseEraProximity)
      .forEach((trackId) =>
        pushCandidate(candidates, trackId, "releaseEraProximity", 1, {
          canonicalReleaseId: currentTrack.canonicalReleaseId,
        }),
      );

    (snapshot.releaseAdjacency[currentTrack.canonicalReleaseId] ?? []).forEach((releaseId) => {
      (snapshot.releaseToTracks[releaseId] ?? []).forEach((trackId) => {
        pushCandidate(candidates, trackId, "releaseEraProximity", 0.45, {
          adjacentReleaseId: releaseId,
        });
      });
    });
  }

  Object.entries(context.recentTagCloud)
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, config.candidatePoolSizes.sessionContinuation)
    .forEach(([tagId, weight]) => {
      (snapshot.tagToTracks[tagId] ?? []).forEach((trackId) => {
        pushCandidate(candidates, trackId, "sessionContinuation", weight, { tagId });
      });
    });

  topAffinityKeys(profiles.entity.artistAffinities, 10).forEach((artistId) => {
    (snapshot.artistToTracks[artistId] ?? []).forEach((trackId) => {
      pushCandidate(
        candidates,
        trackId,
        "userAffinityRetrieval",
        profiles.entity.artistAffinities[artistId]?.value ?? 0,
        { artistId },
      );
    });
  });
  topAffinityKeys(profiles.entity.tagAffinities, 12).forEach((tagId) => {
    (snapshot.tagToTracks[tagId] ?? []).forEach((trackId) => {
      pushCandidate(
        candidates,
        trackId,
        "userAffinityRetrieval",
        profiles.entity.tagAffinities[tagId]?.value ?? 0,
        { tagId },
      );
    });
  });
  topAffinityKeys(profiles.entity.trackAffinities, 12).forEach((trackId) => {
    if (snapshot.tracksById[trackId]) {
      pushCandidate(
        candidates,
        trackId,
        "userAffinityRetrieval",
        profiles.entity.trackAffinities[trackId]?.value ?? 0,
        { affinityTrackId: trackId },
      );
    }
  });

  return [...candidates.values()]
    .filter((candidate) => candidate.canonicalTrackId !== currentTrack?.canonicalTrackId)
    .sort((left, right) => {
      if (left.baseScore !== right.baseScore) {
        return right.baseScore - left.baseScore;
      }

      return left.canonicalTrackId.localeCompare(right.canonicalTrackId);
    });
}
