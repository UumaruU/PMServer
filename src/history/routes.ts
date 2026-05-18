import type { FastifyPluginAsync } from "fastify";
import { HistoryEventType, Prisma } from "@prisma/client";

import { discoveryService } from "../discovery/discovery.service";
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

const dedupeSyncHistoryEntries = <T extends { trackId: string; listenedAt: string; dayKey: string }>(
  entries: T[],
) => {
  const deduped = new Map<string, T>();

  entries.forEach((entry) => {
    const key = `${entry.trackId}:${entry.dayKey}`;
    const existing = deduped.get(key);

    if (!existing || Date.parse(entry.listenedAt) > Date.parse(existing.listenedAt)) {
      deduped.set(key, entry);
    }
  });

  return [...deduped.values()].sort(
    (left, right) => Date.parse(right.listenedAt) - Date.parse(left.listenedAt),
  );
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

    if (body.eventType === HistoryEventType.COMPLETED) {
      void discoveryService
        .enqueueFromPlayback(app.prisma, userId, body.trackId, {
          source: "history_event",
          playedMs: body.playedMs ?? null,
        })
        .catch((error) => {
          app.log.warn({ error, userId, trackId: body.trackId }, "Failed to enqueue discovery seed from playback history.");
        });
    }

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

      const items = dedupeSyncHistoryEntries(
        response.items.map((item) => {
          const trackId = toExternalTrackId(item.track);
          const dayKey = buildDayKey(item.createdAt);

          return {
            id: `${trackId}:${dayKey}`,
            trackId,
            listenedAt: item.createdAt.toISOString(),
            dayKey,
          };
        }),
      );

      return {
        items,
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

      void discoveryService
        .enqueueFromPlayback(app.prisma, request.authUser!.userId, internalTrack.id, {
          source: "history_sync_event",
          playedMs: body.playedMs ?? null,
          occurredAt: listenedAt.toISOString(),
        })
        .catch((error) => {
          app.log.warn(
            { error, userId: request.authUser!.userId, trackId: internalTrack.id },
            "Failed to enqueue discovery seed from synced playback history.",
          );
        });

      return reply.code(201).send({
        event: {
          id: `${body.trackId}:${buildDayKey(listenedAt)}`,
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

      const dedupedEntries = dedupeSyncHistoryEntries(
        normalizedEntries.map((entry) => ({
          ...entry,
          listenedAt: entry.listenedAt.toISOString(),
          dayKey: buildDayKey(entry.listenedAt),
        })),
      ).map((entry) => ({
        trackId: entry.trackId,
        listenedAt: new Date(entry.listenedAt),
      }));

      const trackMap = await ensureSyncTracks(
        app.prisma,
        dedupedEntries.map((entry) => entry.trackId),
      );

      await app.prisma.$transaction(async (tx) => {
        await tx.userHistoryEvent.deleteMany({
          where: {
            userId: request.authUser!.userId,
          },
        });

        if (!dedupedEntries.length) {
          return;
        }

        const createManyData: Array<{
          userId: string;
          trackId: string;
          eventType: HistoryEventType;
          createdAt: Date;
        }> = dedupedEntries.flatMap((entry) => {
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

      const syncedTrackIds = [...new Set([...trackMap.values()].map((track) => track.id))];
      await Promise.allSettled(
        syncedTrackIds.map((trackId) =>
          discoveryService.enqueueFromPlayback(app.prisma, request.authUser!.userId, trackId, {
            source: "history_sync",
          }),
        ),
      );

      return reply.code(204).send();
    },
  );
};
