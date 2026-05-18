import { describe, expect, it } from "vitest";

import { createEmptyProfiles } from "../src/recommendation/affinity/profileStore";
import { defaultRecommendationConfig } from "../src/recommendation/config/defaultRecommendationConfig";
import { getRankedTrackRecommendations } from "../src/recommendation/next-track/getNextRecommendedTrack";
import type {
  RecommendationCatalogSnapshot,
  RecommendationContext,
  UserRecommendationFeatures,
} from "../src/recommendation/types";

function buildTrack(params: {
  id: string;
  title: string;
  artistId: string;
  releaseId: string;
  tagIds: string[];
  popularityPrior?: number;
}) {
  return {
    canonicalTrackId: params.id,
    title: params.title,
    normalizedTitleCore: params.title.toLowerCase(),
    titleFlavor: ["original"],
    canonicalArtistIds: [params.artistId],
    primaryCanonicalArtistId: params.artistId,
    featuringCanonicalArtistIds: [],
    canonicalReleaseId: params.releaseId,
    year: 2024,
    labelIds: [],
    language: null,
    explicit: false,
    targetDurationMs: 200_000,
    tagIds: params.tagIds,
    tagWeights: Object.fromEntries(params.tagIds.map((tagId) => [tagId, 1])),
    preferredVariantId: `variant:${params.id}`,
    playableVariantIds: [`variant:${params.id}`],
    sourceEvidence: [],
    quality: {
      clusterConfidence: 0.92,
      trustScore: 0.86,
      metadataCompleteness: 0.86,
      popularityPrior: params.popularityPrior ?? 0.14,
    },
  } satisfies RecommendationCatalogSnapshot["tracksById"][string];
}

function buildArtist(params: {
  id: string;
  name: string;
  tagIds: string[];
  relatedArtistIds?: string[];
  frequentCollaboratorIds?: string[];
  releaseIds: string[];
  trackIds: string[];
}) {
  return {
    canonicalArtistId: params.id,
    musicBrainzArtistId: params.id,
    name: params.name,
    normalizedName: params.name.toLowerCase(),
    aliases: [],
    country: "US",
    type: "Person",
    tagIds: params.tagIds,
    tagWeights: Object.fromEntries(params.tagIds.map((tagId) => [tagId, 1])),
    relatedArtistIds: params.relatedArtistIds ?? [],
    frequentCollaboratorIds: params.frequentCollaboratorIds ?? [],
    releaseIds: params.releaseIds,
    trackIds: params.trackIds,
    sourceEvidence: [],
    quality: {
      confidence: 0.88,
      trustScore: 0.84,
      metadataCompleteness: 0.82,
    },
  } satisfies RecommendationCatalogSnapshot["artistsById"][string];
}

function buildRelease(id: string, artistId: string, trackIds: string[], tagIds: string[]) {
  return {
    canonicalReleaseId: id,
    musicBrainzReleaseId: id,
    musicBrainzReleaseGroupId: `${id}:group`,
    title: id,
    canonicalArtistIds: [artistId],
    releaseType: "album",
    year: 2024,
    labelIds: [],
    coverUrl: null,
    trackIds,
    tagIds,
    sourceEvidence: [],
    quality: {
      confidence: 0.82,
      trustScore: 0.82,
      metadataCompleteness: 0.8,
    },
  } satisfies RecommendationCatalogSnapshot["releasesById"][string];
}

function buildFeatures(): UserRecommendationFeatures {
  return {
    strategy: "user-feed",
    contextSummary: "taste profile",
    favoriteVariantIds: ["variant:track:fav"],
    topArtists: [{ id: "artist:fav", score: 18 }],
    topTags: [
      { id: "tag:synth", score: 16 },
      { id: "tag:night", score: 12 },
    ],
    topTracks: [{ id: "track:fav", score: 20 }],
    topReleases: [{ id: "release:fav", score: 10 }],
    playlistTrackScores: {},
    sessionTransitionScores: {},
    searchIntent: {
      queries: [],
      trackScores: {},
      artistScores: {},
      tagScores: {},
    },
    negative: {
      hardSuppressedTrackIds: [],
      temporarilyHiddenTrackIds: [],
      fatiguePenaltyByTrackId: {},
    },
    hasStrongPersonalSignals: true,
  };
}

function createSnapshot(): RecommendationCatalogSnapshot {
  const tracksById = {
    "track:fav": buildTrack({
      id: "track:fav",
      title: "Favorite Anchor",
      artistId: "artist:fav",
      releaseId: "release:fav",
      tagIds: ["tag:synth", "tag:night"],
      popularityPrior: 0.18,
    }),
    "track:fav-2": buildTrack({
      id: "track:fav-2",
      title: "Favorite Again",
      artistId: "artist:fav",
      releaseId: "release:fav-2",
      tagIds: ["tag:synth", "tag:night"],
      popularityPrior: 0.16,
    }),
    "track:related": buildTrack({
      id: "track:related",
      title: "Related Horizon",
      artistId: "artist:related",
      releaseId: "release:related",
      tagIds: ["tag:synth", "tag:night"],
      popularityPrior: 0.12,
    }),
    "track:collab": buildTrack({
      id: "track:collab",
      title: "Collab City",
      artistId: "artist:collab",
      releaseId: "release:collab",
      tagIds: ["tag:synth", "tag:night"],
      popularityPrior: 0.11,
    }),
    "track:offgenre": buildTrack({
      id: "track:offgenre",
      title: "Metal Storm",
      artistId: "artist:offgenre",
      releaseId: "release:offgenre",
      tagIds: ["tag:metal"],
      popularityPrior: 0.18,
    }),
  };

  const artistsById = {
    "artist:fav": buildArtist({
      id: "artist:fav",
      name: "Favorite Artist",
      tagIds: ["tag:synth", "tag:night"],
      relatedArtistIds: ["artist:related"],
      frequentCollaboratorIds: ["artist:collab"],
      releaseIds: ["release:fav", "release:fav-2"],
      trackIds: ["track:fav", "track:fav-2"],
    }),
    "artist:related": buildArtist({
      id: "artist:related",
      name: "Related Artist",
      tagIds: ["tag:synth", "tag:night"],
      relatedArtistIds: ["artist:fav"],
      releaseIds: ["release:related"],
      trackIds: ["track:related"],
    }),
    "artist:collab": buildArtist({
      id: "artist:collab",
      name: "Collab Artist",
      tagIds: ["tag:synth", "tag:night"],
      frequentCollaboratorIds: ["artist:fav"],
      releaseIds: ["release:collab"],
      trackIds: ["track:collab"],
    }),
    "artist:offgenre": buildArtist({
      id: "artist:offgenre",
      name: "Offgenre Artist",
      tagIds: ["tag:metal"],
      releaseIds: ["release:offgenre"],
      trackIds: ["track:offgenre"],
    }),
  };

  return {
    snapshotRevision: "snapshot:candidate-diversity",
    generatedAt: "2026-04-01T00:00:00.000Z",
    canonicalizationVersion: 1,
    canonicalizationRevision: 1,
    tracksById,
    artistsById,
    releasesById: {
      "release:fav": buildRelease("release:fav", "artist:fav", ["track:fav"], ["tag:synth", "tag:night"]),
      "release:fav-2": buildRelease("release:fav-2", "artist:fav", ["track:fav-2"], ["tag:synth", "tag:night"]),
      "release:related": buildRelease("release:related", "artist:related", ["track:related"], ["tag:synth", "tag:night"]),
      "release:collab": buildRelease("release:collab", "artist:collab", ["track:collab"], ["tag:synth", "tag:night"]),
      "release:offgenre": buildRelease("release:offgenre", "artist:offgenre", ["track:offgenre"], ["tag:metal"]),
    },
    tagsById: {
      "tag:synth": {
        canonicalTagId: "tag:synth",
        slug: "synth",
        displayName: "Synth",
        aliases: [],
        tagType: "genre",
        parentTagId: null,
        normalizedForm: "synth",
        sourceEvidence: [],
        quality: { confidence: 0.9, trustScore: 0.85 },
      },
      "tag:night": {
        canonicalTagId: "tag:night",
        slug: "night",
        displayName: "Night",
        aliases: [],
        tagType: "theme",
        parentTagId: null,
        normalizedForm: "night",
        sourceEvidence: [],
        quality: { confidence: 0.86, trustScore: 0.8 },
      },
      "tag:metal": {
        canonicalTagId: "tag:metal",
        slug: "metal",
        displayName: "Metal",
        aliases: [],
        tagType: "genre",
        parentTagId: null,
        normalizedForm: "metal",
        sourceEvidence: [],
        quality: { confidence: 0.8, trustScore: 0.78 },
      },
    },
    canonicalIdByVariantTrackId: {
      "variant:track:fav": "track:fav",
      "variant:track:fav-2": "track:fav-2",
      "variant:track:related": "track:related",
      "variant:track:collab": "track:collab",
      "variant:track:offgenre": "track:offgenre",
    },
    artistToTracks: {
      "artist:fav": ["track:fav", "track:fav-2"],
      "artist:related": ["track:related"],
      "artist:collab": ["track:collab"],
      "artist:offgenre": ["track:offgenre"],
    },
    releaseToTracks: {
      "release:fav": ["track:fav"],
      "release:fav-2": ["track:fav-2"],
      "release:related": ["track:related"],
      "release:collab": ["track:collab"],
      "release:offgenre": ["track:offgenre"],
    },
    trackToArtists: {
      "track:fav": ["artist:fav"],
      "track:fav-2": ["artist:fav"],
      "track:related": ["artist:related"],
      "track:collab": ["artist:collab"],
      "track:offgenre": ["artist:offgenre"],
    },
    artistToReleases: {
      "artist:fav": ["release:fav", "release:fav-2"],
      "artist:related": ["release:related"],
      "artist:collab": ["release:collab"],
      "artist:offgenre": ["release:offgenre"],
    },
    artistRelations: {
      "artist:fav": [
        {
          leftId: "artist:fav",
          rightId: "artist:collab",
          weight: 0.82,
          source: "derived",
          confidence: 0.88,
          reason: "collaborated_with",
        },
      ],
      "artist:collab": [
        {
          leftId: "artist:collab",
          rightId: "artist:fav",
          weight: 0.82,
          source: "derived",
          confidence: 0.88,
          reason: "collaborated_with",
        },
      ],
    },
    relatedArtists: {
      "artist:fav": [
        {
          leftId: "artist:fav",
          rightId: "artist:related",
          weight: 0.86,
          source: "derived",
          confidence: 0.9,
          reason: "shared-tag-similarity",
        },
      ],
      "artist:related": [
        {
          leftId: "artist:related",
          rightId: "artist:fav",
          weight: 0.86,
          source: "derived",
          confidence: 0.9,
          reason: "shared-tag-similarity",
        },
      ],
    },
    tagToTracks: {
      "tag:synth": ["track:fav", "track:fav-2", "track:related", "track:collab"],
      "tag:night": ["track:fav", "track:fav-2", "track:related", "track:collab"],
      "tag:metal": ["track:offgenre"],
    },
    tagToArtists: {
      "tag:synth": ["artist:fav", "artist:related", "artist:collab"],
      "tag:night": ["artist:fav", "artist:related", "artist:collab"],
      "tag:metal": ["artist:offgenre"],
    },
    releaseAdjacency: {
      "release:fav": ["release:fav-2", "release:related", "release:collab"],
      "release:fav-2": ["release:fav", "release:related", "release:collab"],
      "release:related": ["release:fav", "release:collab"],
      "release:collab": ["release:fav", "release:related"],
      "release:offgenre": [],
    },
    playableVariantsByCanonicalTrackId: {
      "track:fav": ["variant:track:fav"],
      "track:fav-2": ["variant:track:fav-2"],
      "track:related": ["variant:track:related"],
      "track:collab": ["variant:track:collab"],
      "track:offgenre": ["variant:track:offgenre"],
    },
  };
}

describe("recommendation candidate generation", () => {
  it("moves beyond the favorite artist through related, collaborator and tag discovery without going off-genre", () => {
    const snapshot = createSnapshot();
    const context = {
      mode: "autoplay",
      currentCanonicalTrackId: null,
      currentPrimaryArtistId: null,
      playbackPrimaryArtistId: null,
      currentFeaturedArtistIds: [],
      currentTrackTagIds: [],
      currentArtistTagIds: [],
      currentReleaseId: null,
      currentFlavor: null,
      currentDurationMs: null,
      recentTrackIds: [],
      recentArtistIds: [],
      recentTagCloud: {
        "tag:synth": 2,
        "tag:night": 1.5,
      },
      recentRecommendationIds: [],
      skippedTrackIds: [],
      favoritedTrackIds: ["track:fav"],
      userFeatures: buildFeatures(),
    } satisfies RecommendationContext;

    const profiles = createEmptyProfiles();
    profiles.bootstrap.discoveryLevel = "balanced";
    profiles.entity.artistAffinities["artist:fav"] = {
      value: 9,
      updatedAt: "2026-04-01T00:00:00.000Z",
      eventCount: 3,
    };
    profiles.entity.tagAffinities["tag:synth"] = {
      value: 7,
      updatedAt: "2026-04-01T00:00:00.000Z",
      eventCount: 3,
    };
    profiles.entity.tagAffinities["tag:night"] = {
      value: 5,
      updatedAt: "2026-04-01T00:00:00.000Z",
      eventCount: 2,
    };

    const ranking = getRankedTrackRecommendations({
      seed: {
        mode: "autoplay",
      },
      context,
      snapshot,
      profiles,
      config: defaultRecommendationConfig,
    });

    const topThreeIds = ranking.slice(0, 3).map((item) => item.canonicalTrackId);

    expect(topThreeIds).toEqual(
      expect.arrayContaining(["track:related", "track:collab"]),
    );
    expect(topThreeIds).not.toContain("track:offgenre");
  });

  it("puts a discovered related artist ahead of more same-artist tracks from favorites", () => {
    const snapshot = createSnapshot();
    const context = {
      mode: "autoplay",
      currentCanonicalTrackId: null,
      currentPrimaryArtistId: null,
      playbackPrimaryArtistId: null,
      currentFeaturedArtistIds: [],
      currentTrackTagIds: [],
      currentArtistTagIds: [],
      currentReleaseId: null,
      currentFlavor: null,
      currentDurationMs: null,
      recentTrackIds: [],
      recentArtistIds: [],
      recentTagCloud: {
        "tag:synth": 2,
        "tag:night": 1.5,
      },
      recentRecommendationIds: [],
      skippedTrackIds: [],
      favoritedTrackIds: ["track:fav"],
      userFeatures: buildFeatures(),
    } satisfies RecommendationContext;

    const profiles = createEmptyProfiles();
    profiles.bootstrap.discoveryLevel = "balanced";
    profiles.entity.artistAffinities["artist:fav"] = {
      value: 16,
      updatedAt: "2026-04-01T00:00:00.000Z",
      eventCount: 6,
    };
    profiles.entity.tagAffinities["tag:synth"] = {
      value: 7,
      updatedAt: "2026-04-01T00:00:00.000Z",
      eventCount: 3,
    };

    const ranking = getRankedTrackRecommendations({
      seed: {
        mode: "autoplay",
      },
      context,
      snapshot,
      profiles,
      config: defaultRecommendationConfig,
    });

    expect(["track:related", "track:collab"]).toContain(ranking[0]?.canonicalTrackId);
    expect(snapshot.tracksById[ranking[0]!.canonicalTrackId]!.primaryCanonicalArtistId).not.toBe("artist:fav");
  });
});
