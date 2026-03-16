import type { FastifyPluginAsync } from "fastify";

const searchHistoryBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 255 },
          query: { type: "string", minLength: 1, maxLength: 255 },
          createdAt: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
    },
  },
} as const;

function normalizeQuery(value: string) {
  return value.trim();
}

function dedupeEntries(
  items: Array<{ id?: string; query: string; createdAt?: string }>,
) {
  const deduped = new Map<string, { id: string; query: string; createdAt: string }>();

  items.forEach((item) => {
    const query = normalizeQuery(item.query);
    if (!query) {
      return;
    }

    const createdAt =
      item.createdAt && !Number.isNaN(Date.parse(item.createdAt))
        ? new Date(item.createdAt).toISOString()
        : new Date().toISOString();
    const key = query.toLowerCase();
    const existing = deduped.get(key);

    if (!existing || Date.parse(createdAt) > Date.parse(existing.createdAt)) {
      deduped.set(key, {
        id: item.id?.trim() || `${query}:${createdAt}`,
        query,
        createdAt,
      });
    }
  });

  return [...deduped.values()]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 8);
}

// Future backend extraction point: search history is user state persisted on the server, not a search execution backend.
export const searchHistoryRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/sync/search-history",
    {
      preHandler: [app.authenticate],
    },
    async (request) => {
      const items = await app.prisma.userSearchHistoryEntry.findMany({
        where: {
          userId: request.authUser!.userId,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 8,
      });

      return {
        items: items.map((entry: { id: string; query: string; createdAt: Date }) => ({
          id: entry.id,
          query: entry.query,
          createdAt: entry.createdAt.toISOString(),
        })),
      };
    },
  );

  app.put(
    "/sync/search-history",
    {
      preHandler: [app.authenticate],
      schema: {
        body: searchHistoryBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        items: Array<{ id?: string; query: string; createdAt?: string }>;
      };
      const items = dedupeEntries(body.items);

      await app.prisma.$transaction(async (tx) => {
        await tx.userSearchHistoryEntry.deleteMany({
          where: {
            userId: request.authUser!.userId,
          },
        });

        if (!items.length) {
          return;
        }

        await tx.userSearchHistoryEntry.createMany({
          data: items.map((item) => ({
            userId: request.authUser!.userId,
            query: item.query,
            createdAt: new Date(item.createdAt),
          })),
        });
      });

      return reply.code(204).send();
    },
  );
};
