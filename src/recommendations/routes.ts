import type { FastifyPluginAsync } from "fastify";

import { recommendationService } from "./service";

const recommendationModeEnum = [
  "next-track",
  "track-radio",
  "artist-radio",
  "autoplay",
  "related-tracks",
  "related-artists",
] as const;

const recommendationChannelEnum = [
  "sameArtist",
  "frequentCollaborators",
  "relatedArtists",
  "sharedTags",
  "releaseEraProximity",
  "sessionContinuation",
  "userAffinityRetrieval",
  "userTopArtists",
  "userTopTags",
  "userTopTracks",
  "playlistCooccurrence",
  "sessionTransitions",
  "searchIntent",
  "adjacentDiscovery",
  "safeExploration",
] as const;

const nextTrackBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    currentTrackId: { type: ["string", "null"], minLength: 1, maxLength: 255 },
    mode: { type: "string", enum: recommendationModeEnum },
    recentRecommendationTrackIds: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: 255,
      },
    },
    skippedTrackIds: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: 255,
      },
    },
  },
} as const;

const streamBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 50 },
    mode: { type: "string", enum: recommendationModeEnum },
    seedTrackId: { type: ["string", "null"], minLength: 1, maxLength: 255 },
    currentTrackId: { type: ["string", "null"], minLength: 1, maxLength: 255 },
    excludeTrackIds: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: 255,
      },
    },
    recentRecommendationTrackIds: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: 255,
      },
    },
  },
} as const;

const playbackEventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId", "listenedMs", "trackDurationMs", "occurredAt", "endedNaturally", "wasSkipped", "sessionId"],
  properties: {
    trackId: { type: "string", minLength: 1, maxLength: 255 },
    listenedMs: { type: "integer", minimum: 0 },
    trackDurationMs: { type: "integer", minimum: 0 },
    occurredAt: { type: "string", minLength: 1, maxLength: 255 },
    endedNaturally: { type: "boolean" },
    wasSkipped: { type: "boolean" },
    sessionId: { type: "string", minLength: 1, maxLength: 255 },
    seedChannels: {
      type: "array",
      items: {
        type: "string",
        enum: recommendationChannelEnum,
      },
    },
  },
} as const;

const favoriteEventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId", "occurredAt", "isFavorite"],
  properties: {
    trackId: { type: "string", minLength: 1, maxLength: 255 },
    occurredAt: { type: "string", minLength: 1, maxLength: 255 },
    isFavorite: { type: "boolean" },
  },
} as const;

const playlistEventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId", "playlistId", "occurredAt", "isAdded"],
  properties: {
    trackId: { type: "string", minLength: 1, maxLength: 255 },
    playlistId: { type: "string", minLength: 1, maxLength: 255 },
    occurredAt: { type: "string", minLength: 1, maxLength: 255 },
    isAdded: { type: "boolean" },
  },
} as const;

const dislikeEventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId", "occurredAt", "isDisliked"],
  properties: {
    trackId: { type: "string", minLength: 1, maxLength: 255 },
    occurredAt: { type: "string", minLength: 1, maxLength: 255 },
    isDisliked: { type: "boolean" },
  },
} as const;

const onboardingProfileBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    artistIds: {
      type: "array",
      minItems: 0,
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 255 },
    },
    artistNames: {
      type: "array",
      minItems: 0,
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 255 },
    },
    tags: {
      type: "array",
      minItems: 0,
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 255 },
    },
    languages: {
      type: "array",
      minItems: 0,
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 64 },
    },
    discoveryLevel: {
      type: "string",
      enum: ["safe", "balanced", "exploratory"],
    },
  },
} as const;

const impressionsEventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requestId", "surface", "position", "trackId", "occurredAt"],
        properties: {
          requestId: { type: "string", minLength: 1, maxLength: 255 },
          surface: { type: "string", minLength: 1, maxLength: 255 },
          position: { type: "integer", minimum: 0, maximum: 1000 },
          trackId: { type: "string", minLength: 1, maxLength: 255 },
          occurredAt: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
    },
  },
} as const;

const interactionEventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "surface", "position", "trackId", "action", "occurredAt"],
  properties: {
    requestId: { type: "string", minLength: 1, maxLength: 255 },
    surface: { type: "string", minLength: 1, maxLength: 255 },
    position: { type: "integer", minimum: 0, maximum: 1000 },
    trackId: { type: "string", minLength: 1, maxLength: 255 },
    action: {
      type: "string",
      enum: ["open", "play", "skip", "queue", "dismiss", "favorite", "playlist_add"],
    },
    occurredAt: { type: "string", minLength: 1, maxLength: 255 },
    listenedMs: { type: "integer", minimum: 0 },
    trackDurationMs: { type: "integer", minimum: 0 },
    playlistId: { type: "string", minLength: 1, maxLength: 255 },
    metadata: { type: ["object", "null"] },
  },
} as const;

// Future backend extraction point: this is the transport layer over the pure recommendation domain.
export const recommendationsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/me/recommendations/next-track",
    {
      preHandler: [app.authenticate],
      schema: {
        body: nextTrackBodySchema,
      },
    },
    async (request) =>
      recommendationService.getNextRecommendedTrack(app.prisma, request.authUser!.userId, request.body as {
        currentTrackId?: string | null;
        recentRecommendationTrackIds?: string[];
        skippedTrackIds?: string[];
        mode?: (typeof recommendationModeEnum)[number];
      }),
  );

  app.post(
    "/me/recommendations/stream",
    {
      preHandler: [app.authenticate],
      schema: {
        body: streamBodySchema,
      },
    },
    async (request) =>
      recommendationService.getRecommendationStreamBatch(app.prisma, request.authUser!.userId, request.body as {
        limit?: number;
        mode?: (typeof recommendationModeEnum)[number];
        seedTrackId?: string | null;
        currentTrackId?: string | null;
        excludeTrackIds?: string[];
        recentRecommendationTrackIds?: string[];
      }),
  );

  app.post(
    "/me/recommendations/onboarding-profile",
    {
      preHandler: [app.authenticate],
      schema: {
        body: onboardingProfileBodySchema,
      },
    },
    async (request) =>
      recommendationService.saveOnboardingProfile(app.prisma, request.authUser!.userId, request.body as {
        artistIds?: string[];
        artistNames?: string[];
        tags?: string[];
        languages?: string[];
        discoveryLevel?: "safe" | "balanced" | "exploratory";
      }),
  );

  app.post(
    "/me/recommendations/events/playback",
    {
      preHandler: [app.authenticate],
      schema: {
        body: playbackEventBodySchema,
      },
    },
    async (request, reply) => {
      await recommendationService.updatePlaybackAffinity(
        app.prisma,
        request.authUser!.userId,
        request.body as {
          trackId: string;
          listenedMs: number;
          trackDurationMs: number;
          occurredAt: string;
          endedNaturally: boolean;
          wasSkipped: boolean;
          sessionId: string;
          seedChannels?: (typeof recommendationChannelEnum)[number][];
        },
      );

      return reply.code(204).send();
    },
  );

  app.post(
    "/me/recommendations/events/impressions",
    {
      preHandler: [app.authenticate],
      schema: {
        body: impressionsEventBodySchema,
      },
    },
    async (request, reply) => {
      await recommendationService.recordRecommendationImpressions(
        app.prisma,
        request.authUser!.userId,
        request.body as {
          items: Array<{
            requestId: string;
            surface: string;
            position: number;
            trackId: string;
            occurredAt: string;
          }>;
        },
      );

      return reply.code(204).send();
    },
  );

  app.post(
    "/me/recommendations/events/interaction",
    {
      preHandler: [app.authenticate],
      schema: {
        body: interactionEventBodySchema,
      },
    },
    async (request, reply) => {
      await recommendationService.recordRecommendationInteraction(
        app.prisma,
        request.authUser!.userId,
        request.body as {
          requestId: string;
          surface: string;
          position: number;
          trackId: string;
          action: "open" | "play" | "skip" | "queue" | "dismiss" | "favorite" | "playlist_add";
          occurredAt: string;
          listenedMs?: number;
          trackDurationMs?: number;
          playlistId?: string;
          metadata?: Record<string, unknown> | null;
        },
      );

      return reply.code(204).send();
    },
  );

  app.post(
    "/me/recommendations/events/favorite",
    {
      preHandler: [app.authenticate],
      schema: {
        body: favoriteEventBodySchema,
      },
    },
    async (request, reply) => {
      await recommendationService.updateFavoriteAffinity(
        app.prisma,
        request.authUser!.userId,
        request.body as {
          trackId: string;
          occurredAt: string;
          isFavorite: boolean;
        },
      );

      return reply.code(204).send();
    },
  );

  app.post(
    "/me/recommendations/events/playlist",
    {
      preHandler: [app.authenticate],
      schema: {
        body: playlistEventBodySchema,
      },
    },
    async (request, reply) => {
      await recommendationService.updatePlaylistAffinity(
        app.prisma,
        request.authUser!.userId,
        request.body as {
          trackId: string;
          playlistId: string;
          occurredAt: string;
          isAdded: boolean;
        },
      );

      return reply.code(204).send();
    },
  );

  app.post(
    "/me/recommendations/events/dislike",
    {
      preHandler: [app.authenticate],
      schema: {
        body: dislikeEventBodySchema,
      },
    },
    async (request, reply) => {
      await recommendationService.updateDislikeAffinity(
        app.prisma,
        request.authUser!.userId,
        request.body as {
          trackId: string;
          occurredAt: string;
          isDisliked: boolean;
        },
      );

      return reply.code(204).send();
    },
  );
};
