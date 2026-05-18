import { buildApp } from "./app";
import { backfillDiscoveryIndex } from "./discovery/backfillDiscoveryIndex";
import { startDiscoveryWorker, type DiscoveryWorker } from "./discovery/discoveryWorker";
import { indexGrowthController } from "./discovery/indexGrowthController";

const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const start = async (): Promise<void> => {
  const app = await buildApp();
  let discoveryWorker: DiscoveryWorker | null = null;
  let isShuttingDown = false;

  const closeGracefully = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    app.log.info({ signal }, "Received shutdown signal.");

    try {
      discoveryWorker?.stop();
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error(error, "Failed to shut down gracefully.");
      process.exit(1);
    }
  };

  for (const signal of shutdownSignals) {
    process.once(signal, () => {
      void closeGracefully(signal);
    });
  }

  try {
    if (app.config.discoveryBackfillOnStartup) {
      const result = await backfillDiscoveryIndex({
        prisma: app.prisma,
        logger: app.log,
        batchSize: app.config.discoveryBackfillBatchSize,
      });
      app.log.info(result, "Discovery index backfill completed.");
    } else {
      app.log.info("Discovery index backfill disabled.");
    }

    const bootstrapJobsQueued = await indexGrowthController.enqueueGlobalBootstrap(app.prisma);
    app.log.info({ bootstrapJobsQueued }, "Discovery bootstrap index growth queued.");

    if (app.config.discoveryWorkerEnabled) {
      discoveryWorker = startDiscoveryWorker({
        prisma: app.prisma,
        logger: app.log,
        maxJobsPerTick: app.config.discoveryMaxJobsPerTick,
      });
      app.log.info("Discovery worker started.");
    } else {
      app.log.info("Discovery worker disabled.");
    }

    await app.listen({
      host: app.config.host,
      port: app.config.port,
    });
  } catch (error) {
    app.log.error(error);
    await app.close();
    process.exit(1);
  }
};

void start();
