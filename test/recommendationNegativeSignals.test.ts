import { describe, expect, it } from "vitest";

import { createEmptyProfiles } from "../src/recommendation/affinity/profileStore";
import { defaultRecommendationConfig } from "../src/recommendation/config/defaultRecommendationConfig";
import { filterScoredCandidates } from "../src/recommendation/filtering/filterCandidates";
import type { RecommendationCatalogSnapshot, RecommendationContext } from "../src/recommendation/types";

function track(id: string) {
  return {
    canonicalTrackId: id,
    preferredVariantId: `variant:${id}`,
    playableVariantIds: [`variant:${id}`],
    quality: {
      clusterConfidence: 0.9,
    },
  } as RecommendationCatalogSnapshot["tracksById"][string];
}

describe("recommendation negative signals", () => {
  it("keeps one regular skip eligible for reranking but hard-filters fast skips", () => {
    const profiles = createEmptyProfiles();
    profiles.session.recentSkippedTrackIds = ["track:regular-skip"];
    profiles.session.recentFastSkippedTrackIds = ["track:fast-skip"];
    profiles.entity.fastSkippedTrackIds = ["track:fast-skip"];

    const snapshot = {
      tracksById: {
        "track:regular-skip": track("track:regular-skip"),
        "track:fast-skip": track("track:fast-skip"),
      },
    } as unknown as RecommendationCatalogSnapshot;
    const context = {
      currentCanonicalTrackId: null,
      favoritedTrackIds: [],
      recentTrackIds: [],
      skippedTrackIds: [],
      userFeatures: {
        negative: {
          hardSuppressedTrackIds: [],
          temporarilyHiddenTrackIds: [],
          fatiguePenaltyByTrackId: {},
        },
      },
    } as unknown as RecommendationContext;
    const filtered = filterScoredCandidates({
      candidates: [
        {
          canonicalTrackId: "track:regular-skip",
          scoreBreakdown: { finalScore: 1 },
          __track: snapshot.tracksById["track:regular-skip"],
        },
        {
          canonicalTrackId: "track:fast-skip",
          scoreBreakdown: { finalScore: 1 },
          __track: snapshot.tracksById["track:fast-skip"],
        },
      ],
      snapshot,
      context,
      profiles,
      config: defaultRecommendationConfig,
    });

    expect(filtered.map((candidate) => candidate.canonicalTrackId)).toEqual(["track:regular-skip"]);
  });
});
