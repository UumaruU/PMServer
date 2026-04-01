import { describe, expect, it } from "vitest";

import { buildRecommendationCatalogSnapshot } from "../src/recommendation/canonical-graph/snapshotBuilder";
import { defaultRecommendationConfig } from "../src/recommendation/config/defaultRecommendationConfig";

describe("recommendation canonicalization", () => {
  it("keeps playable singleton tracks above the recommendation confidence floor", () => {
    const snapshot = buildRecommendationCatalogSnapshot({
      tracks: [
        {
          id: "hitmos:singleton-1",
          providerId: "hitmos",
          providerTrackId: "singleton-1",
          title: "Night Drive",
          artist: "Northern Lights",
          coverUrl: "",
          audioUrl: "https://example.invalid/audio.mp3",
          duration: 210000,
          sourceUrl: "https://example.invalid/source",
          isFavorite: true,
          metadataStatus: "raw",
          sourcePriority: 34,
          sourceTrustScore: 0.35,
        },
      ],
      artists: [],
      releases: [],
      providerMetadata: {
        hitmos: {
          providerId: "hitmos",
          sourcePriority: 34,
          sourceTrustScore: 0.35,
          popularityPrior: 0.15,
        },
      },
      config: defaultRecommendationConfig,
    });

    const track = Object.values(snapshot.tracksById)[0];

    expect(track).toBeDefined();
    expect(track.preferredVariantId).toBe("hitmos:singleton-1");
    expect(track.playableVariantIds).toEqual(["hitmos:singleton-1"]);
    expect(track.targetDurationMs).toBe(210000);
    expect(track.quality.clusterConfidence).toBeGreaterThanOrEqual(
      defaultRecommendationConfig.filtering.minCanonicalConfidence,
    );
  });
});
