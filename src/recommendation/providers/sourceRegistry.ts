import {
  ProviderFieldTrust,
  RecommendationProviderDefinition,
  RecommendationProviderId,
} from "../types";

function createFieldTrust(overrides: Partial<ProviderFieldTrust>): ProviderFieldTrust {
  return {
    identity: 0,
    releaseMetadata: 0,
    tags: 0,
    collaboration: 0,
    playback: 0,
    popularityPrior: 0,
    ...overrides,
  };
}

// Pure domain logic: provider trust policy is backend-friendly and independent of UI/runtime fetchers.
export const recommendationSourceRegistry: Record<
  RecommendationProviderId,
  RecommendationProviderDefinition
> = {
  musicbrainz: {
    providerId: "musicbrainz",
    tier: "primary",
    supportedEntityTypes: ["artist", "track", "release", "tag"],
    roles: ["identity", "release-metadata", "artist-relations", "tags"],
    fieldTrust: createFieldTrust({
      identity: 1,
      releaseMetadata: 0.95,
      tags: 0.65,
      collaboration: 0.95,
    }),
    mergePriority: 100,
    precisionBias: "strict",
  },
  acoustid: {
    providerId: "acoustid",
    tier: "primary",
    supportedEntityTypes: ["track"],
    roles: ["audio-identity"],
    fieldTrust: createFieldTrust({
      identity: 1,
    }),
    mergePriority: 95,
    precisionBias: "strict",
  },
  "cover-art-archive": {
    providerId: "cover-art-archive",
    tier: "secondary",
    supportedEntityTypes: ["release", "track"],
    roles: ["artwork"],
    fieldTrust: createFieldTrust({
      releaseMetadata: 1,
    }),
    mergePriority: 90,
    precisionBias: "strict",
  },
  lastfm: {
    providerId: "lastfm",
    tier: "secondary",
    supportedEntityTypes: ["artist", "track", "tag"],
    roles: ["tags", "similar-artists", "track-similarity", "weak-popularity"],
    fieldTrust: createFieldTrust({
      tags: 0.75,
      collaboration: 0.55,
      popularityPrior: 0.4,
    }),
    mergePriority: 70,
    precisionBias: "balanced",
  },
  discogs: {
    providerId: "discogs",
    tier: "secondary",
    supportedEntityTypes: ["artist", "release", "tag"],
    roles: ["release-metadata", "styles", "credits", "labels"],
    fieldTrust: createFieldTrust({
      identity: 0.6,
      releaseMetadata: 0.9,
      tags: 0.85,
      collaboration: 0.8,
    }),
    mergePriority: 80,
    precisionBias: "strict",
  },
  listenbrainz: {
    providerId: "listenbrainz",
    tier: "secondary",
    supportedEntityTypes: ["artist", "track"],
    roles: ["weak-popularity", "recommendation-prior", "similarity"],
    fieldTrust: createFieldTrust({
      popularityPrior: 0.75,
      collaboration: 0.45,
    }),
    mergePriority: 60,
    precisionBias: "balanced",
  },
  soundcloud: {
    providerId: "soundcloud",
    tier: "secondary",
    supportedEntityTypes: ["artist", "track", "tag"],
    roles: ["playback", "long-tail-catalog", "weak-tags"],
    fieldTrust: createFieldTrust({
      identity: 0.45,
      tags: 0.55,
      collaboration: 0.35,
      playback: 0.8,
      popularityPrior: 0.3,
    }),
    mergePriority: 50,
    precisionBias: "balanced",
  },
  jamendo: {
    providerId: "jamendo",
    tier: "secondary",
    supportedEntityTypes: ["artist", "track", "release", "tag"],
    roles: ["playback", "open-catalog", "metadata"],
    fieldTrust: createFieldTrust({
      identity: 0.45,
      releaseMetadata: 0.6,
      tags: 0.5,
      playback: 0.75,
      popularityPrior: 0.25,
    }),
    mergePriority: 48,
    precisionBias: "balanced",
  },
  wikidata: {
    providerId: "wikidata",
    tier: "secondary",
    supportedEntityTypes: ["artist", "release"],
    roles: ["external-ids", "country", "region", "type"],
    fieldTrust: createFieldTrust({
      identity: 0.6,
      releaseMetadata: 0.55,
    }),
    mergePriority: 45,
    precisionBias: "strict",
  },
  lmusic: {
    providerId: "lmusic",
    tier: "scrape",
    supportedEntityTypes: ["artist", "track", "tag"],
    roles: ["playback", "weak-metadata", "category-membership"],
    fieldTrust: createFieldTrust({
      identity: 0.35,
      releaseMetadata: 0.35,
      tags: 0.4,
      collaboration: 0.2,
      playback: 0.92,
      popularityPrior: 0.2,
    }),
    mergePriority: 35,
    precisionBias: "strict",
  },
  hitmo: {
    providerId: "hitmo",
    tier: "scrape",
    supportedEntityTypes: ["artist", "track", "tag"],
    roles: ["playback", "weak-metadata", "category-membership"],
    fieldTrust: createFieldTrust({
      identity: 0.35,
      releaseMetadata: 0.35,
      tags: 0.4,
      collaboration: 0.2,
      playback: 0.8,
      popularityPrior: 0.2,
    }),
    mergePriority: 34,
    precisionBias: "strict",
  },
  hitmos: {
    providerId: "hitmos",
    tier: "scrape",
    supportedEntityTypes: ["artist", "track", "tag"],
    roles: ["playback", "weak-metadata", "category-membership"],
    fieldTrust: createFieldTrust({
      identity: 0.35,
      releaseMetadata: 0.35,
      tags: 0.4,
      collaboration: 0.2,
      playback: 0.8,
      popularityPrior: 0.2,
    }),
    mergePriority: 34,
    precisionBias: "strict",
  },
  telegram: {
    providerId: "telegram",
    tier: "playback-only",
    supportedEntityTypes: ["track"],
    roles: ["playback"],
    fieldTrust: createFieldTrust({
      playback: 0.45,
    }),
    mergePriority: 10,
    precisionBias: "strict",
  },
};

export function getProviderDefinition(providerId: RecommendationProviderId) {
  return recommendationSourceRegistry[providerId] ?? recommendationSourceRegistry.lmusic;
}

export function getProviderPriority(providerId: RecommendationProviderId) {
  return getProviderDefinition(providerId).mergePriority;
}

export function getProviderTrustScore(providerId: RecommendationProviderId) {
  const definition = getProviderDefinition(providerId);
  return Math.max(
    definition.fieldTrust.identity,
    definition.fieldTrust.releaseMetadata,
    definition.fieldTrust.playback,
    definition.fieldTrust.tags,
    definition.fieldTrust.popularityPrior,
  );
}
