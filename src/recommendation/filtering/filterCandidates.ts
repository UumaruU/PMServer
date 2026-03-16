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
  return params.candidates.filter((candidate) => {
    const track = candidate.__track;

    if (!track) {
      return false;
    }

    if (params.context.currentCanonicalTrackId === candidate.canonicalTrackId) {
      return false;
    }

    if (!track.preferredVariantId || !track.playableVariantIds.includes(track.preferredVariantId)) {
      return false;
    }

    if (track.quality.clusterConfidence < params.config.filtering.minCanonicalConfidence) {
      return false;
    }

    if (params.profiles.entity.dislikedTrackIds.includes(track.canonicalTrackId)) {
      return false;
    }

    if (params.context.skippedTrackIds.includes(track.canonicalTrackId)) {
      return false;
    }

    return true;
  });
}
