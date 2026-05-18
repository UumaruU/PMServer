import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";

import { serializeTrackForClient } from "../tracks/serializers";
import { discoveryService } from "../discovery/discovery.service";
import { AppError } from "../utils/errors";
import { ensureSyncTracks, ensureTrackExists, toExternalTrackId } from "../tracks/service";

const trackIdBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId"],
  properties: {
    trackId: { type: "string", format: "uuid" },
  },
} as const;

const trackIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId"],
  properties: {
    trackId: { type: "string", format: "uuid" },
  },
} as const;

const syncFavoritesBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackIds"],
  properties: {
    trackIds: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
    },
  },
} as const;

export const favoritesRoutes: FastifyPluginAsync = async (app) => {
  const listFavorites = async (userId: string) => {
    const favorites = await app.prisma.favorite.findMany({
      where: {
        userId,
      },
      include: {
        track: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return {
      items: favorites.map((favorite) => favorite.track),
    };
  };

  const addFavorite = async (userId: string, trackId: string) => {
    const track = await ensureTrackExists(app.prisma, trackId);

    try {
      await app.prisma.favorite.create({
        data: {
          userId,
          trackId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new AppError(409, "FAVORITE_ALREADY_EXISTS", "Track is already in favorites.");
      }

      throw error;
    }

    void discoveryService.enqueueFromFavorite(app.prisma, userId, trackId).catch((error) => {
      app.log.warn({ error, userId, trackId }, "Failed to enqueue discovery seed from favorite.");
    });

    return { track };
  };

  const removeFavorite = async (userId: string, trackId: string) => {
    await app.prisma.favorite.deleteMany({
      where: {
        userId,
        trackId,
      },
    });
  };

  app.get(
    "/me/favorites",
    {
      preHandler: [app.authenticate],
    },
    async (request) => listFavorites(request.authUser!.userId),
  );

  app.post(
    "/me/favorites",
    {
      preHandler: [app.authenticate],
      schema: {
        body: trackIdBodySchema,
      },
    },
    async (request, reply) =>
      reply.code(201).send(await addFavorite(request.authUser!.userId, (request.body as { trackId: string }).trackId)),
  );

  app.delete(
    "/me/favorites/:trackId",
    {
      preHandler: [app.authenticate],
      schema: {
        params: trackIdParamsSchema,
      },
    },
    async (request, reply) => {
      await removeFavorite(request.authUser!.userId, (request.params as { trackId: string }).trackId);
      return reply.code(204).send();
    },
  );

  app.get(
    "/sync/favorites",
    {
      preHandler: [app.authenticate],
    },
    async (request) => {
      const favorites = await app.prisma.favorite.findMany({
        where: {
          userId: request.authUser!.userId,
        },
        include: {
          track: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return {
        favorites: favorites.map((favorite) => toExternalTrackId(favorite.track)),
        tracks: favorites.map((favorite) => serializeTrackForClient(favorite.track, { isFavorite: true })),
      };
    },
  );

  app.put(
    "/sync/favorites",
    {
      preHandler: [app.authenticate],
      schema: {
        body: syncFavoritesBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as { trackIds: string[] };
      const externalTrackIds = [...new Set(body.trackIds.map((trackId) => trackId.trim()).filter(Boolean))];
      const trackMap = await ensureSyncTracks(app.prisma, externalTrackIds);
      const desiredTrackIds = [...new Set([...trackMap.values()].map((track) => track.id))];

      await app.prisma.$transaction(async (tx) => {
        await tx.favorite.deleteMany({
          where: {
            userId: request.authUser!.userId,
            ...(desiredTrackIds.length ? { trackId: { notIn: desiredTrackIds } } : {}),
          },
        });

        if (!desiredTrackIds.length) {
          await tx.favorite.deleteMany({
            where: {
              userId: request.authUser!.userId,
            },
          });
          return;
        }

        const existingFavorites = await tx.favorite.findMany({
          where: {
            userId: request.authUser!.userId,
            trackId: {
              in: desiredTrackIds,
            },
          },
          select: {
            trackId: true,
          },
        });

        const existingTrackIds = new Set(existingFavorites.map((favorite) => favorite.trackId));
        const missingTrackIds = desiredTrackIds.filter((trackId) => !existingTrackIds.has(trackId));

        if (missingTrackIds.length) {
          await tx.favorite.createMany({
            data: missingTrackIds.map((trackId) => ({
              userId: request.authUser!.userId,
              trackId,
            })),
            skipDuplicates: true,
          });
        }
      });

      await Promise.allSettled(
        desiredTrackIds.map((trackId) => discoveryService.enqueueFromFavorite(app.prisma, request.authUser!.userId, trackId)),
      );

      return reply.code(204).send();
    },
  );
};
