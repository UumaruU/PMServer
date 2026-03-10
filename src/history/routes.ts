import type { FastifyPluginAsync } from "fastify";
import { HistoryEventType, Prisma } from "@prisma/client";

import { ensureSyncTracks, ensureTrackExists, toExternalTrackId } from "../tracks/service";

const createHistoryBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId", "eventType"],
  properties: {
    trackId: { type: "string", format: "uuid" },
    eventType: { type: "string", enum: Object.values(HistoryEventType) },
    playedMs: { type: "integer", minimum: 0 },
    context: {
      type: ["object", "array", "string", "number", "boolean", "null"],
    },
  },
} as const;

const historyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

const syncHistoryBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["trackId", "listenedAt"],
        properties: {
          id: { type: "string", minLength: 1 },
          trackId: { type: "string", minLength: 1 },
          listenedAt: { type: "string", minLength: 1 },
          dayKey: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

const buildDayKey = (value: Date): string => {
  const year = value.getUTCFullYear();
  const month = `${value.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${value.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const historyRoutes: FastifyPluginAsync = async (app) => {
  const createHistoryEvent = async (
    userId: string,
    body: {
      trackId: string;
      eventType: HistoryEventType;
      playedMs?: number;
      context?: unknown;
    },
  ) => {
    await ensureTrackExists(app.prisma, body.trackId);

    const event = await app.prisma.userHistoryEvent.create({
      data: {
        userId,
        trackId: body.trackId,
        eventType: body.eventType,
        playedMs: body.playedMs,
        context: body.context as Prisma.InputJsonValue | undefined,
      },
      include: {
        track: true,
      },
    });

    return { event };
  };

  const listHistory = async (userId: string, query: { limit?: number; offset?: number }) => {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [items, total] = await app.prisma.$transaction([
      app.prisma.userHistoryEvent.findMany({
        where: {
          userId,
        },
        include: {
          track: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: limit,
        skip: offset,
      }),
      app.prisma.userHistoryEvent.count({
        where: {
          userId,
        },
      }),
    ]);

    return {
      items,
      pagination: {
        limit,
        offset,
        total,
      },
    };
  };

  app.post(
    "/me/history/events",
    {
      preHandler: [app.authenticate],
      schema: {
        body: createHistoryBodySchema,
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await createHistoryEvent(
          request.authUser!.userId,
          request.body as {
            trackId: string;
            eventType: HistoryEventType;
            playedMs?: number;
            context?: unknown;
          },
        ),
      ),
  );

  app.get(
    "/me/history",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: historyQuerySchema,
      },
    },
    async (request) =>
      listHistory(
        request.authUser!.userId,
        request.query as { limit?: number; offset?: number },
      ),
  );

  app.get(
    "/sync/history",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: historyQuerySchema,
      },
    },
    async (request) => {
      const response = await listHistory(
        request.authUser!.userId,
        request.query as { limit?: number; offset?: number },
      );

      return {
        items: response.items.map((item) => ({
          id: item.id,
          trackId: toExternalTrackId(item.track),
          listenedAt: item.createdAt.toISOString(),
          dayKey: buildDayKey(item.createdAt),
        })),
      };
    },
  );

  app.post(
    "/sync/history/events",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["trackId"],
          properties: {
            trackId: { type: "string", minLength: 1 },
            listenedAt: { type: "string", minLength: 1 },
            playedMs: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        trackId: string;
        listenedAt?: string;
        playedMs?: number;
      };
      const track = await ensureSyncTracks(app.prisma, [body.trackId]);
      const internalTrack = track.get(body.trackId)!;
      const listenedAt =
        body.listenedAt && !Number.isNaN(Date.parse(body.listenedAt))
          ? new Date(body.listenedAt)
          : new Date();

      const event = await app.prisma.userHistoryEvent.create({
        data: {
          userId: request.authUser!.userId,
          trackId: internalTrack.id,
          eventType: HistoryEventType.COMPLETED,
          playedMs: body.playedMs,
          createdAt: listenedAt,
          context: {
            source: "sync",
          },
        },
      });

      return reply.code(201).send({
        event: {
          id: event.id,
          trackId: body.trackId,
          listenedAt: listenedAt.toISOString(),
          dayKey: buildDayKey(listenedAt),
        },
      });
    },
  );

  app.put(
    "/sync/history",
    {
      preHandler: [app.authenticate],
      schema: {
        body: syncHistoryBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        entries: Array<{
          id?: string;
          trackId: string;
          listenedAt: string;
          dayKey?: string;
        }>;
      };

      const normalizedEntries = body.entries
        .map((entry) => ({
          trackId: entry.trackId.trim(),
          listenedAt:
            !Number.isNaN(Date.parse(entry.listenedAt))
              ? new Date(entry.listenedAt)
              : new Date(),
        }))
        .filter((entry) => entry.trackId);

      const trackMap = await ensureSyncTracks(
        app.prisma,
        normalizedEntries.map((entry) => entry.trackId),
      );

      await app.prisma.$transaction(async (tx) => {
        await tx.userHistoryEvent.deleteMany({
          where: {
            userId: request.authUser!.userId,
          },
        });

        if (!normalizedEntries.length) {
          return;
        }

        const createManyData: Array<{
          userId: string;
          trackId: string;
          eventType: HistoryEventType;
          createdAt: Date;
        }> = normalizedEntries.flatMap((entry) => {
          const track = trackMap.get(entry.trackId);

          if (!track) {
            return [];
          }

          return [
            {
              userId: request.authUser!.userId,
              trackId: track.id,
              eventType: HistoryEventType.COMPLETED,
              createdAt: entry.listenedAt,
            },
          ];
        });

        await tx.userHistoryEvent.createMany({
          data: createManyData,
        });
      });

      return reply.code(204).send();
    },
  );
};
