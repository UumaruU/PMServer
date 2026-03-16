import { RecommendationCatalogSnapshot, RecommendationConfig, RecommendationContext } from "../types";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// Pure domain logic: diversification is applied after scoring and before final selection.
export function applyDiversification<
  T extends {
    canonicalTrackId: string;
    scoreBreakdown: { finalScore: number };
    penaltiesApplied: { repetitionPenalty: number; totalPenalty: number };
    __track: RecommendationCatalogSnapshot["tracksById"][string];
  },
>(params: {
  candidates: T[];
  snapshot: RecommendationCatalogSnapshot;
  context: RecommendationContext;
  config: RecommendationConfig;
}) {
  const recentArtistCounts = params.context.recentArtistIds.reduce<Record<string, number>>((accumulator, artistId) => {
    accumulator[artistId] = (accumulator[artistId] ?? 0) + 1;
    return accumulator;
  }, {});
  const recentReleaseCounts = params.context.recentTrackIds.reduce<Record<string, number>>((accumulator, trackId) => {
    const track = params.snapshot.tracksById[trackId];
    if (track?.canonicalReleaseId) {
      accumulator[track.canonicalReleaseId] = (accumulator[track.canonicalReleaseId] ?? 0) + 1;
    }
    return accumulator;
  }, {});
  const recentTagCounts = params.context.recentTrackIds.reduce<Record<string, number>>((accumulator, trackId) => {
    const track = params.snapshot.tracksById[trackId];
    track?.tagIds.forEach((tagId) => {
      accumulator[tagId] = (accumulator[tagId] ?? 0) + 1;
    });
    return accumulator;
  }, {});

  return params.candidates
    .map((candidate) => {
      const track = candidate.__track;
      let extraPenalty = 0;

      if (
        track.primaryCanonicalArtistId &&
        (recentArtistCounts[track.primaryCanonicalArtistId] ?? 0) >= params.config.diversification.sameArtistStreak
      ) {
        extraPenalty += 0.75;
      }

      if (
        track.canonicalReleaseId &&
        (recentReleaseCounts[track.canonicalReleaseId] ?? 0) >= params.config.diversification.sameReleaseStreak
      ) {
        extraPenalty += 0.75;
      }

      const repeatedTagCount = track.tagIds.reduce(
        (max, tagId) => Math.max(max, recentTagCounts[tagId] ?? 0),
        0,
      );
      if (repeatedTagCount >= params.config.diversification.sameNarrowTagClusterStreak) {
        extraPenalty += 0.35;
      }

      const cappedPenalty = clamp(
        extraPenalty,
        0,
        Math.max(0, candidate.scoreBreakdown.finalScore * params.config.diversification.maxPenaltyShare),
      );
      candidate.penaltiesApplied.repetitionPenalty += cappedPenalty;
      candidate.penaltiesApplied.totalPenalty += cappedPenalty;
      candidate.scoreBreakdown.finalScore -= cappedPenalty;
      return candidate;
    })
    .sort((left, right) => {
      if (left.scoreBreakdown.finalScore !== right.scoreBreakdown.finalScore) {
        return right.scoreBreakdown.finalScore - left.scoreBreakdown.finalScore;
      }

      return left.canonicalTrackId.localeCompare(right.canonicalTrackId);
    });
}
