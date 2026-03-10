import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";

import { AppError } from "../utils/errors";
import {
  ensureSyncTracks,
  ensureTrackExists,
  isUuid,
  toExternalTrackId,
} from "../tracks/service";

const playlistIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["playlistId"],
  properties: {
    playlistId: { type: "string", format: "uuid" },
  },
} as const;

const playlistTrackParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["playlistId", "trackId"],
  properties: {
    playlistId: { type: "string", format: "uuid" },
    trackId: { type: "string", format: "uuid" },
  },
} as const;

const createPlaylistBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: ["string", "null"], maxLength: 500 },
  },
} as const;

const updatePlaylistBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: ["string", "null"], maxLength: 500 },
  },
} as const;

const addTrackBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId"],
  properties: {
    trackId: { type: "string", format: "uuid" },
  },
} as const;

const syncPlaylistsBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["playlists"],
  properties: {
    playlists: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1, maxLength: 120 },
          trackIds: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
            },
          },
          createdAt: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

const serializePlaylist = (playlist: {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  tracks: Array<{
    id: string;
    trackId: string;
    position: number;
    createdAt: Date;
    track: {
      id: string;
      source: string;
      sourceTrackId: string;
    };
  }>;
}) => ({
  id: playlist.id,
  userId: playlist.userId,
  name: playlist.name,
  description: playlist.description,
  createdAt: playlist.createdAt,
  updatedAt: playlist.updatedAt,
  tracks: playlist.tracks.map((item) => ({
    id: item.id,
    trackId: item.trackId,
    position: item.position,
    createdAt: item.createdAt,
    track: item.track,
  })),
});

const serializeSyncPlaylist = (playlist: {
  id: string;
  name: string;
  createdAt: Date;
  tracks: Array<{
    track: {
      id: string;
      source: string;
      sourceTrackId: string;
    };
  }>;
}) => ({
  id: playlist.id,
  name: playlist.name,
  trackIds: playlist.tracks.map((item) => toExternalTrackId(item.track)),
  createdAt: playlist.createdAt.toISOString(),
});

const getOwnedPlaylist = async (
  app: FastifyInstance,
  userId: string,
  playlistId: string,
) => {
  const playlist = await app.prisma.playlist.findFirst({
    where: {
      id: playlistId,
      userId,
    },
    include: {
      tracks: {
        include: {
          track: true,
        },
        orderBy: {
          position: "asc",
        },
      },
    },
  });

  if (!playlist) {
    throw new AppError(404, "PLAYLIST_NOT_FOUND", "Playlist not found.");
  }

  return playlist;
};

export const playlistsRoutes: FastifyPluginAsync = async (app) => {
  const listPlaylists = async (userId: string) => {
    const playlists = await app.prisma.playlist.findMany({
      where: {
        userId,
      },
      include: {
        tracks: {
          include: {
            track: true,
          },
          orderBy: {
            position: "asc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return {
      items: playlists.map(serializePlaylist),
    };
  };

  const createPlaylist = async (
    userId: string,
    body: { name: string; description?: string | null },
  ) => {
    const playlist = await app.prisma.playlist.create({
      data: {
        userId,
        name: body.name,
        description: body.description ?? null,
      },
      include: {
        tracks: {
          include: {
            track: true,
          },
        },
      },
    });

    return { playlist: serializePlaylist(playlist) };
  };

  const updatePlaylist = async (
    userId: string,
    playlistId: string,
    body: { name?: string; description?: string | null },
  ) => {
    await getOwnedPlaylist(app, userId, playlistId);

    const playlist = await app.prisma.playlist.update({
      where: {
        id: playlistId,
      },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
      include: {
        tracks: {
          include: {
            track: true,
          },
          orderBy: {
            position: "asc",
          },
        },
      },
    });

    return {
      playlist: serializePlaylist(playlist),
    };
  };

  const deletePlaylist = async (userId: string, playlistId: string) => {
    await getOwnedPlaylist(app, userId, playlistId);

    await app.prisma.playlist.delete({
      where: {
        id: playlistId,
      },
    });
  };

  const addTrackToPlaylist = async (
    userId: string,
    playlistId: string,
    trackId: string,
  ) => {
    await ensureTrackExists(app.prisma, trackId);
    await getOwnedPlaylist(app, userId, playlistId);

    const aggregate = await app.prisma.playlistTrack.aggregate({
      where: {
        playlistId,
      },
      _max: {
        position: true,
      },
    });

    try {
      await app.prisma.playlistTrack.create({
        data: {
          playlistId,
          trackId,
          position: (aggregate._max.position ?? 0) + 1,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new AppError(409, "PLAYLIST_TRACK_EXISTS", "Track is already in the playlist.");
      }

      throw error;
    }

    const playlist = await getOwnedPlaylist(app, userId, playlistId);
    return { playlist: serializePlaylist(playlist) };
  };

  const removeTrackFromPlaylist = async (
    userId: string,
    playlistId: string,
    trackId: string,
  ) => {
    await getOwnedPlaylist(app, userId, playlistId);

    await app.prisma.playlistTrack.deleteMany({
      where: {
        playlistId,
        trackId,
      },
    });
  };

  app.get(
    "/me/playlists",
    {
      preHandler: [app.authenticate],
    },
    async (request) => listPlaylists(request.authUser!.userId),
  );

  app.post(
    "/me/playlists",
    {
      preHandler: [app.authenticate],
      schema: {
        body: createPlaylistBodySchema,
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await createPlaylist(
            request.authUser!.userId,
            request.body as { name: string; description?: string | null },
          ),
        ),
  );

  app.patch(
    "/me/playlists/:playlistId",
    {
      preHandler: [app.authenticate],
      schema: {
        params: playlistIdParamsSchema,
        body: updatePlaylistBodySchema,
      },
    },
    async (request) =>
      updatePlaylist(
        request.authUser!.userId,
        (request.params as { playlistId: string }).playlistId,
        request.body as { name?: string; description?: string | null },
      ),
  );

  app.delete(
    "/me/playlists/:playlistId",
    {
      preHandler: [app.authenticate],
      schema: {
        params: playlistIdParamsSchema,
      },
    },
    async (request, reply) => {
      await deletePlaylist(
        request.authUser!.userId,
        (request.params as { playlistId: string }).playlistId,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/me/playlists/:playlistId/tracks",
    {
      preHandler: [app.authenticate],
      schema: {
        params: playlistIdParamsSchema,
        body: addTrackBodySchema,
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await addTrackToPlaylist(
            request.authUser!.userId,
            (request.params as { playlistId: string }).playlistId,
            (request.body as { trackId: string }).trackId,
          ),
        ),
  );

  app.delete(
    "/me/playlists/:playlistId/tracks/:trackId",
    {
      preHandler: [app.authenticate],
      schema: {
        params: playlistTrackParamsSchema,
      },
    },
    async (request, reply) => {
      const params = request.params as { playlistId: string; trackId: string };
      await removeTrackFromPlaylist(request.authUser!.userId, params.playlistId, params.trackId);
      return reply.code(204).send();
    },
  );

  app.get(
    "/sync/playlists",
    {
      preHandler: [app.authenticate],
    },
    async (request) => {
      const playlists = await app.prisma.playlist.findMany({
        where: {
          userId: request.authUser!.userId,
        },
        include: {
          tracks: {
            include: {
              track: {
                select: {
                  id: true,
                  source: true,
                  sourceTrackId: true,
                },
              },
            },
            orderBy: {
              position: "asc",
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return {
        playlists: playlists.map(serializeSyncPlaylist),
      };
    },
  );

  app.put(
    "/sync/playlists",
    {
      preHandler: [app.authenticate],
      schema: {
        body: syncPlaylistsBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        playlists: Array<{
          id?: string;
          name: string;
          trackIds?: string[];
          createdAt?: string;
        }>;
      };

      const normalizedPlaylists = body.playlists
        .map((playlist) => ({
          id: playlist.id && isUuid(playlist.id) ? playlist.id : randomUUID(),
          name: playlist.name.trim(),
          trackIds: [...new Set((playlist.trackIds ?? []).map((trackId) => trackId.trim()).filter(Boolean))],
          createdAt:
            playlist.createdAt && !Number.isNaN(Date.parse(playlist.createdAt))
              ? new Date(playlist.createdAt)
              : new Date(),
        }))
        .filter((playlist) => playlist.name);

      await app.prisma.$transaction(async (tx) => {
        const desiredPlaylistIds = normalizedPlaylists.map((playlist) => playlist.id);

        await tx.playlist.deleteMany({
          where: {
            userId: request.authUser!.userId,
            ...(desiredPlaylistIds.length ? { id: { notIn: desiredPlaylistIds } } : {}),
          },
        });

        if (!desiredPlaylistIds.length) {
          await tx.playlist.deleteMany({
            where: {
              userId: request.authUser!.userId,
            },
          });
          return;
        }

        for (const playlist of normalizedPlaylists) {
          const existingPlaylist = await tx.playlist.findFirst({
            where: {
              id: playlist.id,
              userId: request.authUser!.userId,
            },
          });

          if (existingPlaylist) {
            await tx.playlist.update({
              where: {
                id: playlist.id,
              },
              data: {
                name: playlist.name,
              },
            });
          } else {
            await tx.playlist.create({
              data: {
                id: playlist.id,
                userId: request.authUser!.userId,
                name: playlist.name,
                createdAt: playlist.createdAt,
              },
            });
          }

          await tx.playlistTrack.deleteMany({
            where: {
              playlistId: playlist.id,
            },
          });

          if (!playlist.trackIds.length) {
            continue;
          }

          const trackMap = await ensureSyncTracks(tx, playlist.trackIds);
          await tx.playlistTrack.createMany({
            data: playlist.trackIds
              .map((trackId, index) => {
                const track = trackMap.get(trackId);

                if (!track) {
                  return null;
                }

                return {
                  playlistId: playlist.id,
                  trackId: track.id,
                  position: index + 1,
                };
              })
              .filter((item): item is { playlistId: string; trackId: string; position: number } => !!item),
            skipDuplicates: true,
          });
        }
      });

      return reply.code(204).send();
    },
  );
};
