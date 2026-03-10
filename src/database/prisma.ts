import { PrismaClient } from "@prisma/client";

export const createPrismaClient = (databaseUrl?: string): PrismaClient =>
  new PrismaClient({
    datasources: databaseUrl
      ? {
          db: {
            url: databaseUrl,
          },
        }
      : undefined,
  });

