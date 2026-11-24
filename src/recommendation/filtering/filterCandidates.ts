import {
  RecommendationCatalogSnapshot,
  RecommendationContext,
  RecommendationProfiles,
} from "../types";

export type RecommendationFilterReason =
  | "missing_track"
  | "current_track"
  | "favorite"
  | "recent_favorite"
  | "recently_played"
  | "no_playable_source"
  | "low_quality"
  | "hard_suppressed"
  | "temporarily_hidden"
  | "non_positive_score";

export interface RecommendationFilterDecision {
  included: boolean;
  reason?: RecommendationFilterReason;
  details?: Record<string, unknown>;
}

function buildSuppressionSets(params: {
  context: RecommendationContext;
  profiles: RecommendationProfiles;
}) {
  return {
    hardSuppressedTrackIds: new Set([
      ...params.profiles.entity.dislikedTrackIds,
      ...params.profiles.entity.fastSkippedTrackIds,
      ...params.profiles.entity.dismissedTrackIds,
      ...params.profiles.session.recentDislikedTrackIds,
      ...params.profiles.session.recentFastSkippedTrackIds,
      ...params.profiles.session.recentDismissedTrackIds,
      ...(params.context.userFeatures?.negative.hardSuppressedTrackIds ?? []),
    ]),
    temporarilyHiddenTrackIds: new Set(params.context.userFeatures?.negative.temporarilyHiddenTrackIds ?? []),
  };
}

export function explainScoredCandidateFilter<
  T extends {
    canonicalTrackId: string;
    scoreBreakdown: { finalScore: number };
    __track: RecommendationCatalogSnapshot["tracksById"][string];
  },
>(params: {
  candidate: T;
  snapshot: RecommendationCatalogSnapshot;
  context: RecommendationContext;
  profiles: RecommendationProfiles;
  minCanonicalConfidence: number;
}): RecommendationFilterDecision {
  void params.snapshot;
  const track = params.candidate.__track;
  const { hardSuppressedTrackIds, temporarilyHiddenTrackIds } = buildSuppressionSets(params);

  if (!track) {
    return {
      included: false,
      reason: "missing_track",
    };
  }

  if (params.context.currentCanonicalTrackId === params.candidate.canonicalTrackId) {
    return {
      included: false,
      reason: "current_track",
    };
  }

  if (params.context.favoritedTrackIds.includes(params.candidate.canonicalTrackId)) {
    return {
      included: false,
      reason: "favorite",
    };
  }

  if (params.profiles.session.recentFavoritedTrackIds.includes(params.candidate.canonicalTrackId)) {
    return {
      included: false,
      reason: "recent_favorite",
    };
  }

  if (params.context.recentTrackIds.includes(params.candidate.canonicalTrackId)) {
    return {
      included: false,
      reason: "recently_played",
    };
  }

  if (!track.preferredVariantId || !track.playableVariantIds.includes(track.preferredVariantId)) {
    return {
      included: false,
      reason: "no_playable_source",
      details: {
        preferredVariantId: track.preferredVariantId ?? null,
        playableVariantCount: track.playableVariantIds.length,
      },
    };
  }

  if (track.quality.clusterConfidence < params.minCanonicalConfidence) {
    return {
      included: false,
      reason: "low_quality",
      details: {
        clusterConfidence: track.quality.clusterConfidence,
        minCanonicalConfidence: params.minCanonicalConfidence,
      },
    };
  }

  if (hardSuppressedTrackIds.has(track.canonicalTrackId)) {
    return {
      included: false,
      reason: "hard_suppressed",
    };
  }

  if (temporarilyHiddenTrackIds.has(track.canonicalTrackId)) {
    return {
      included: false,
      reason: "temporarily_hidden",
    };
  }

  if (params.candidate.scoreBreakdown.finalScore <= 0) {
    return {
      included: false,
      reason: "non_positive_score",
      details: {
        finalScore: params.candidate.scoreBreakdown.finalScore,
      },
    };
  }

  return {
    included: true,
  };
}

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
  config: {
    filtering: {
      minCanonicalConfidence: number;
    };
  };
}) {
  return params.candidates.filter((candidate) => {
    return explainScoredCandidateFilter({
      candidate,
      snapshot: params.snapshot,
      context: params.context,
      profiles: params.profiles,
      minCanonicalConfidence: params.config.filtering.minCanonicalConfidence,
    }).included;
  });
}
