import type { Prisma, PrismaClient } from "@prisma/client";

import type { DiscoveryJobType } from "./discovery.types";

type DbClient = PrismaClient | Prisma.TransactionClient;

export async function enqueueDiscoveryJob(
  prisma: DbClient,
  input: {
    seedId?: string | null;
    jobType: DiscoveryJobType;
    payload: Prisma.InputJsonValue;
    priority?: number;
    providerId?: string | null;
    dedupeKey?: string | null;
    rateLimitKey?: string | null;
  },
) {
  return prisma.discoveryJob.create({
    data: {
      seedId: input.seedId ?? null,
      jobType: input.jobType,
      dedupeKey: input.dedupeKey ?? null,
      rateLimitKey: input.rateLimitKey ?? null,
      payload: input.payload,
      priority: input.priority ?? 0,
      providerId: input.providerId ?? null,
    },
  });
}

export async function claimNextDiscoveryJob(prisma: PrismaClient) {
  const job = await prisma.discoveryJob.findFirst({
    where: {
      status: "PENDING",
      runAfter: {
        lte: new Date(),
      },
    },
    orderBy: [
      {
        priority: "desc",
      },
      {
        createdAt: "asc",
      },
    ],
  });

  if (!job) {
    return null;
  }

  return prisma.discoveryJob.update({
    where: {
      id: job.id,
    },
    data: {
      status: "RUNNING",
      attempts: {
        increment: 1,
      },
      startedAt: new Date(),
    },
    include: {
      seed: true,
    },
  });
}
