import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { discoveryService } from "./discovery.service";

export type DiscoveryWorker = {
  stop(): void;
};

export function startDiscoveryWorker(params: {
  prisma: PrismaClient;
  logger: FastifyBaseLogger;
  maxJobsPerTick: number;
  tickIntervalMs?: number;
}): DiscoveryWorker {
  const maxJobsPerTick = Math.max(1, params.maxJobsPerTick);
  const tickIntervalMs = Math.max(1_000, params.tickIntervalMs ?? 15_000);
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = () => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      void tick();
    }, tickIntervalMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (running || stopped) {
      schedule();
      return;
    }

    running = true;
    try {
      for (let index = 0; index < maxJobsPerTick; index += 1) {
        const job = await discoveryService.processNextDiscoveryJob(params.prisma);
        if (!job) {
          break;
        }
      }
    } catch (error) {
      params.logger.warn(error, "Discovery worker tick failed.");
    } finally {
      running = false;
      schedule();
    }
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}
