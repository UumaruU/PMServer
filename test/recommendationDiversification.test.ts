import { describe, expect, it } from "vitest";

import { createEmptyProfiles } from "../src/recommendation/affinity/profileStore";
import { defaultRecommendationConfig } from "../src/recommendation/config/defaultRecommendationConfig";
import { applyDiversification } from "../src/recommendation/diversification/applyDiversification";
import type { RecommendationCatalogSnapshot, RecommendationContext } from "../src/recommendation/types";

function buildTrack(id: string, artistId: string, input: { title?: string; tagIds?: string[] } = {}) {
  const title = input.title ?? id;
  return {
    canonicalTrackId: id,
    primaryCanonicalArtistId: artistId,
    canonicalReleaseId: null,
    tagIds: input.tagIds ?? [],
    normalizedTitleCore: title.toLowerCase(),
    musicBrainzRecordingId: null,
  } as unknown as RecommendationCatalogSnapshot["tracksById"][string];
}

describe("recommendation diversification", () => {
  it("blocks an artist if it already appeared within the last 10 tracks when alternatives exist", () => {
    const snapshot = {
      tracksById: {
        "track:a": buildTrack("track:a", "artist:a"),
        "track:b": buildTrack("track:b", "artist:b"),
        "track:c": buildTrack("track:c", "artist:c"),
      },
    } as unknown as RecommendationCatalogSnapshot;

    const context = {
      recentArtistIds: [
        "artist:x",
        "artist:y",
        "artist:z",
        "artist:w",
        "artist:a",
        "artist:q",
        "artist:r",
        "artist:s",
        "artist:t",
      ],
      recentTrackIds: [],
      userFeatures: {
        topArtists: [
          { id: "artist:a", score: 18 },
          { id: "artist:b", score: 11 },
          { id: "artist:c", score: 8 },
        ],
      },
    } as unknown as RecommendationContext;

    const diversified = applyDiversification({
      candidates: [
        {
          canonicalTrackId: "track:a",
          scoreBreakdown: { finalScore: 12 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:a"],
        },
        {
          canonicalTrackId: "track:b",
          scoreBreakdown: { finalScore: 10 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:b"],
        },
        {
          canonicalTrackId: "track:c",
          scoreBreakdown: { finalScore: 9 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:c"],
        },
      ],
      snapshot,
      context,
      profiles: createEmptyProfiles(),
      config: defaultRecommendationConfig,
    });

    expect(diversified[0]?.canonicalTrackId).toBe("track:b");
  });

  it("falls back to the repeated artist instead of returning nothing when no alternatives exist", () => {
    const snapshot = {
      tracksById: {
        "track:a": buildTrack("track:a", "artist:a"),
      },
    } as unknown as RecommendationCatalogSnapshot;

    const context = {
      recentArtistIds: [
        "artist:a",
        "artist:x",
        "artist:y",
        "artist:z",
        "artist:w",
        "artist:q",
        "artist:r",
        "artist:s",
        "artist:t",
      ],
      recentTrackIds: [],
      userFeatures: {
        topArtists: [{ id: "artist:a", score: 18 }],
      },
    } as unknown as RecommendationContext;

    const diversified = applyDiversification({
      candidates: [
        {
          canonicalTrackId: "track:a",
          scoreBreakdown: { finalScore: 12 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:a"],
        },
      ],
      snapshot,
      context,
      profiles: createEmptyProfiles(),
      config: defaultRecommendationConfig,
    });

    expect(diversified).toHaveLength(1);
    expect(diversified[0]?.canonicalTrackId).toBe("track:a");
  });

  it("treats the currently playing artist as part of cooldown even before playback history is saved", () => {
    const snapshot = {
      tracksById: {
        "track:a": buildTrack("track:a", "artist:a"),
        "track:b": buildTrack("track:b", "artist:b"),
      },
    } as unknown as RecommendationCatalogSnapshot;

    const context = {
      playbackPrimaryArtistId: "artist:a",
      recentArtistIds: [],
      recentTrackIds: [],
      userFeatures: {
        topArtists: [
          { id: "artist:a", score: 20 },
          { id: "artist:b", score: 9 },
        ],
        topTags: [
          { id: "tag:alt", score: 8 },
          { id: "tag:night", score: 5 },
        ],
      },
    } as unknown as RecommendationContext;

    const diversified = applyDiversification({
      candidates: [
        {
          canonicalTrackId: "track:a",
          scoreBreakdown: { finalScore: 12 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:a"],
        },
        {
          canonicalTrackId: "track:b",
          scoreBreakdown: { finalScore: 10 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:b"],
        },
      ],
      snapshot,
      context,
      profiles: createEmptyProfiles(),
      config: defaultRecommendationConfig,
    });

    expect(diversified[0]?.canonicalTrackId).toBe("track:b");
  });

  it("blocks a recently surfaced favorite artist when the pool already has fresh artist alternatives", () => {
    const snapshot = {
      tracksById: {
        "track:a-prev": buildTrack("track:a-prev", "artist:a"),
        "track:a-next": buildTrack("track:a-next", "artist:a"),
        "track:c": buildTrack("track:c", "artist:c"),
        "track:d": buildTrack("track:d", "artist:d"),
      },
    } as unknown as RecommendationCatalogSnapshot;

    const context = {
      recentArtistIds: ["artist:b"],
      recentRecommendationIds: ["track:a-prev"],
      recentTrackIds: [],
      userFeatures: {
        topArtists: [
          { id: "artist:a", score: 22 },
          { id: "artist:c", score: 8 },
          { id: "artist:d", score: 7 },
        ],
        topTags: [
          { id: "tag:alt", score: 8 },
          { id: "tag:night", score: 5 },
        ],
      },
    } as unknown as RecommendationContext;

    const profiles = createEmptyProfiles();
    profiles.entity.artistAffinities["artist:a"] = {
      value: 10,
      updatedAt: "2026-04-01T00:00:00.000Z",
      eventCount: 4,
    };

    const diversified = applyDiversification({
      candidates: [
        {
          canonicalTrackId: "track:a-next",
          scoreBreakdown: { finalScore: 13 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:a-next"],
        },
        {
          canonicalTrackId: "track:c",
          scoreBreakdown: { finalScore: 11 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:c"],
        },
        {
          canonicalTrackId: "track:d",
          scoreBreakdown: { finalScore: 10.5 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:d"],
        },
      ],
      snapshot,
      context,
      profiles,
      config: defaultRecommendationConfig,
    });

    expect(diversified[0]?.canonicalTrackId).toBe("track:c");
    expect(diversified[0]?.__track.primaryCanonicalArtistId).not.toBe("artist:a");
  });

  it("breaks repeated title-token loops when fresh alternatives exist", () => {
    const snapshot = {
      tracksById: {
        "track:night-prev-1": buildTrack("track:night-prev-1", "artist:a", {
          title: "Night Signal",
          tagIds: ["tag:night"],
        }),
        "track:night-prev-2": buildTrack("track:night-prev-2", "artist:b", {
          title: "Night Static",
          tagIds: ["tag:night"],
        }),
        "track:night-next": buildTrack("track:night-next", "artist:c", {
          title: "Night Glass",
          tagIds: ["tag:night"],
        }),
        "track:fresh": buildTrack("track:fresh", "artist:d", {
          title: "Coastal Light",
          tagIds: ["tag:coastal"],
        }),
      },
    } as unknown as RecommendationCatalogSnapshot;

    const context = {
      recentArtistIds: [],
      recentTrackIds: [],
      recentRecommendationIds: ["track:night-prev-1", "track:night-prev-2"],
      userFeatures: {
        topArtists: [
          { id: "artist:c", score: 9 },
          { id: "artist:d", score: 8 },
        ],
        topTags: [
          { id: "tag:night", score: 20 },
          { id: "tag:coastal", score: 8 },
        ],
      },
    } as unknown as RecommendationContext;

    const diversified = applyDiversification({
      candidates: [
        {
          canonicalTrackId: "track:night-next",
          scoreBreakdown: { finalScore: 13 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:night-next"],
        },
        {
          canonicalTrackId: "track:fresh",
          scoreBreakdown: { finalScore: 10 },
          penaltiesApplied: { repetitionPenalty: 0, totalPenalty: 0 },
          __track: snapshot.tracksById["track:fresh"],
        },
      ],
      snapshot,
      context,
      profiles: createEmptyProfiles(),
      config: defaultRecommendationConfig,
    });

    expect(diversified[0]?.canonicalTrackId).toBe("track:fresh");
  });
});
