import {
  RecommendationCatalogSnapshot,
  RecommendationConfig,
  RecommendationContext,
  RecommendationProfiles,
} from "../types";

// Pure domain logic: filtering removes ineligible candidates before diversification/final selection.
export function filterScoredCandidates<
  T extends {
    canonicalTrackId: string;
    scoreBreakdown: { finalScore: number };
    __track: RecommendationCatalogSnapshot["tracksById"][string];
  },
>(params: {
  candidates: T[];
  snapshot: RecommendationCatalogSnapshot;
  context: RecommendationContext;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const hardSuppressedTrackIds = new Set([
    ...params.profiles.entity.dislikedTrackIds,
    ...params.profiles.entity.fastSkippedTrackIds,
    ...params.profiles.entity.dismissedTrackIds,
    ...params.profiles.session.recentDislikedTrackIds,
    ...params.profiles.session.recentFastSkippedTrackIds,
    ...params.profiles.session.recentDismissedTrackIds,
    ...(params.context.userFeatures?.negative.hardSuppressedTrackIds ?? []),
  ]);
  const temporarilyHiddenTrackIds = new Set(params.context.userFeatures?.negative.temporarilyHiddenTrackIds ?? []);

  return params.candidates.filter((candidate) => {
    const track = candidate.__track;

    if (!track) {
      return false;
    }

    if (params.context.currentCanonicalTrackId === candidate.canonicalTrackId) {
      return false;
    }

    if (params.context.favoritedTrackIds.includes(candidate.canonicalTrackId)) {
      return false;
    }

    if (params.profiles.session.recentFavoritedTrackIds.includes(candidate.canonicalTrackId)) {
      return false;
    }

    if (params.context.recentTrackIds.includes(candidate.canonicalTrackId)) {
      return false;
    }

    if (!track.preferredVariantId || !track.playableVariantIds.includes(track.preferredVariantId)) {
      return false;
    }

    if (track.quality.clusterConfidence < params.config.filtering.minCanonicalConfidence) {
      return false;
    }

    if (hardSuppressedTrackIds.has(track.canonicalTrackId)) {
      return false;
    }

    if (temporarilyHiddenTrackIds.has(track.canonicalTrackId)) {
      return false;
    }

    if (candidate.scoreBreakdown.finalScore <= 0) {
      return false;
    }

    return true;
  });
}
