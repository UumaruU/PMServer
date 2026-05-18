import { describe, expect, it } from "vitest";

import {
  buildFreshnessPatch,
  resolveCanonicalIndexStatus,
  resolveSourceIndexStatus,
} from "../src/discovery/ingestion/qualityGates";

describe("discovery quality gates", () => {
  it("does not activate canonical tracks without a playable source", () => {
    expect(
      resolveCanonicalIndexStatus({
        isPlayable: false,
        qualityScore: 0.9,
        matchConfidence: 0.96,
        sourceTrust: 0.9,
      }),
    ).toBe("CANDIDATE");
  });

  it("rejects low-quality sources before they can enter retrieval", () => {
    expect(
      resolveSourceIndexStatus({
        isPlayable: true,
        qualityScore: 0.22,
        matchConfidence: 0.4,
        sourceTrust: 0.2,
      }),
    ).toBe("REJECTED");
  });

  it("promotes high confidence playable tracks to trusted", () => {
    expect(
      resolveCanonicalIndexStatus({
        isPlayable: true,
        qualityScore: 0.91,
        matchConfidence: 0.93,
        sourceTrust: 0.88,
      }),
    ).toBe("TRUSTED");
  });

  it("computes freshness fields for indexed playable metadata", () => {
    const now = new Date("2026-05-18T09:00:00.000Z");
    expect(
      buildFreshnessPatch({
        now,
        isPlayable: true,
        qualityScore: 0.8,
        sourceTrust: 0.7,
      }),
    ).toEqual({
      lastIndexedAt: now,
      lastProviderCheckAt: now,
      lastSeenAt: now,
      metadataFreshness: 0.75,
      playableSourceFreshness: 1,
    });
  });
});
