import type { FastifyPluginAsync } from "fastify";

import { recommendationObservatoryService } from "./recommendationObservatory.service";

type Query = {
  limit?: number;
  offset?: number;
  userId?: string;
  status?: string;
};

type IdParams = {
  id: string;
};

type UserParams = {
  userId: string;
};

type ArtistParams = {
  artistId: string;
};

type TrackParams = {
  trackId: string;
};

const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
    },
    offset: {
      type: "integer",
      minimum: 0,
    },
    userId: {
      type: "string",
      minLength: 1,
      maxLength: 255,
    },
    status: {
      type: "string",
      minLength: 1,
      maxLength: 64,
    },
  },
} as const;

const limitQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
    },
    offset: {
      type: "integer",
      minimum: 0,
    },
  },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 255,
    },
  },
} as const;

const userParamsSchema = {
  type: "object",
  required: ["userId"],
  properties: {
    userId: {
      type: "string",
      minLength: 1,
      maxLength: 255,
    },
  },
} as const;

const artistParamsSchema = {
  type: "object",
  required: ["artistId"],
  properties: {
    artistId: {
      type: "string",
      minLength: 1,
      maxLength: 255,
    },
  },
} as const;

const trackParamsSchema = {
  type: "object",
  required: ["trackId"],
  properties: {
    trackId: {
      type: "string",
      minLength: 1,
      maxLength: 255,
    },
  },
} as const;

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const adminOnly = {
    preHandler: [app.requireAdmin],
  };

  app.get(
    "/admin/recommendations/requests",
    {
      ...adminOnly,
      schema: {
        querystring: listQuerySchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.listRecommendationRequests(app.prisma, request.query as Query),
  );

  app.get(
    "/admin/recommendations/requests/:id",
    {
      ...adminOnly,
      schema: {
        params: idParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getRecommendationRequest(app.prisma, (request.params as IdParams).id),
  );

  app.get(
    "/admin/recommendations/requests/:id/funnel",
    {
      ...adminOnly,
      schema: {
        params: idParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getRecommendationFunnel(app.prisma, (request.params as IdParams).id),
  );

  app.get(
    "/admin/recommendations/requests/:id/candidates",
    {
      ...adminOnly,
      schema: {
        params: idParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getRecommendationCandidates(app.prisma, (request.params as IdParams).id),
  );

  app.get(
    "/admin/recommendations/requests/:id/filtered",
    {
      ...adminOnly,
      schema: {
        params: idParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getRecommendationFiltered(app.prisma, (request.params as IdParams).id),
  );

  app.get(
    "/admin/recommendations/requests/:id/graph",
    {
      ...adminOnly,
      schema: {
        params: idParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getRecommendationGraph(app.prisma, (request.params as IdParams).id),
  );

  app.get(
    "/admin/users/:userId/recommendation-profile",
    {
      ...adminOnly,
      schema: {
        params: userParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getUserRecommendationProfile(app.prisma, (request.params as UserParams).userId),
  );

  app.get(
    "/admin/users/:userId/pool-health",
    {
      ...adminOnly,
      schema: {
        params: userParamsSchema,
        querystring: limitQuerySchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getUserPoolHealth(
        app.prisma,
        (request.params as UserParams).userId,
        request.query as Query,
      ),
  );

  app.get(
    "/admin/discovery/jobs",
    {
      ...adminOnly,
      schema: {
        querystring: listQuerySchema,
      },
    },
    async (request) => recommendationObservatoryService.listDiscoveryJobs(app.prisma, request.query as Query),
  );

  app.get(
    "/admin/discovery/jobs/:id",
    {
      ...adminOnly,
      schema: {
        params: idParamsSchema,
      },
    },
    async (request) => recommendationObservatoryService.getDiscoveryJob(app.prisma, (request.params as IdParams).id),
  );

  app.get(
    "/admin/graph/artists/:artistId",
    {
      ...adminOnly,
      schema: {
        params: artistParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getArtistGraph(app.prisma, (request.params as ArtistParams).artistId),
  );

  app.get(
    "/admin/graph/tracks/:trackId",
    {
      ...adminOnly,
      schema: {
        params: trackParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getTrackGraph(app.prisma, (request.params as TrackParams).trackId),
  );

  app.get(
    "/admin/vector/tracks/:trackId/neighbors",
    {
      ...adminOnly,
      schema: {
        params: trackParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getTrackVectorNeighbors(app.prisma, (request.params as TrackParams).trackId),
  );

  app.get(
    "/admin/vector/artists/:artistId/neighbors",
    {
      ...adminOnly,
      schema: {
        params: artistParamsSchema,
      },
    },
    async (request) =>
      recommendationObservatoryService.getArtistVectorNeighbors(app.prisma, (request.params as ArtistParams).artistId),
  );
};
