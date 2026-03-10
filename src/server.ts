import { buildApp } from "./app";

const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const start = async (): Promise<void> => {
  const app = await buildApp();
  let isShuttingDown = false;

  const closeGracefully = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    app.log.info({ signal }, "Received shutdown signal.");

    try {
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
