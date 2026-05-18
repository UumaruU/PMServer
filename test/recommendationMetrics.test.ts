import { describe, expect, it } from "vitest";

import {
  calculateOfflineRecommendationMetrics,
  calculateOnlineRecommendationMetrics,
} from "../src/recommendation/metrics/recommendationMetrics";

describe("recommendation metrics", () => {
  it("calculates offline quality and liveliness coverage metrics", () => {
    const metrics = calculateOfflineRecommendationMetrics({
      k: 4,
      catalogTrackIds: ["t1", "t2", "t3", "t4", "t5", "t6"],
      catalogArtistIds: ["a1", "a2", "a3"],
      relevantTrackIds: ["t1", "t3", "t5"],
      recommendations: [
        { trackId: "t1", artistId: "a1", clusterId: "c1", shownBefore: false },
        { trackId: "t2", artistId: "a1", clusterId: "c1", shownBefore: true },
        { trackId: "t3", artistId: "a2", clusterId: "c2", shownBefore: false },
        { trackId: "t4", artistId: "a3", clusterId: "c3", shownBefore: false },
      ],
    });

    expect(metrics.recall).toBeCloseTo(2 / 3);
    expect(metrics.ndcg).toBeGreaterThan(0.7);
    expect(metrics.novelty).toBeCloseTo(0.75);
    expect(metrics.catalogCoverage).toBeCloseTo(4 / 6);
    expect(metrics.artistCoverage).toBeCloseTo(1);
    expect(metrics.sameArtistShare).toBeCloseTo(0.5);
  });

  it("calculates online discovery, revisit, annoyance, and fatigue proxies", () => {
    const events = [
      {
        userId: "u1",
        trackId: "t1",
        artistId: "a1",
        eventType: "IMPRESSION",
        occurredAt: "2026-05-01T00:00:00.000Z",
      },
      {
        userId: "u1",
        trackId: "t1",
        artistId: "a1",
        eventType: "SAVE",
        occurredAt: "2026-05-01T00:05:00.000Z",
        isNewArtistForUser: true,
      },
      {
        userId: "u1",
        trackId: "t1",
        artistId: "a1",
        eventType: "PLAY",
        occurredAt: "2026-05-03T00:00:00.000Z",
      },
      {
        userId: "u1",
        trackId: "t2",
        artistId: "a1",
        eventType: "IMPRESSION",
        occurredAt: "2026-05-01T00:30:00.000Z",
      },
      {
        userId: "u1",
        trackId: "t2",
        artistId: "a1",
        eventType: "SKIP",
        occurredAt: "2026-05-01T00:31:00.000Z",
      },
    ];

    const metrics = calculateOnlineRecommendationMetrics({ events });

    expect(metrics.saveRate).toBeCloseTo(0.5);
    expect(metrics.newArtistDiscoveryRate).toBeCloseTo(1);
    expect(metrics.revisit7d).toBeCloseTo(0.5);
    expect(metrics.revisit28d).toBeCloseTo(0.5);
    expect(metrics.annoyanceProxy).toBeCloseTo(0.5);
    expect(metrics.fatigueProxy).toBeCloseTo(0.5);
  });
});
