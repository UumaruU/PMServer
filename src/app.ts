import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifyRateLimit from "@fastify/rate-limit";
import { Prisma } from "@prisma/client";

import { authRoutes } from "./auth/routes";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { createPrismaClient } from "./database/prisma";
import { favoritesRoutes } from "./favorites/routes";
import { historyRoutes } from "./history/routes";
import { playlistsRoutes } from "./playlists/routes";
import { registerAuthDecorator } from "./plugins/auth";
import { settingsRoutes } from "./settings/routes";
import { tracksRoutes } from "./tracks/routes";
import { AppError } from "./utils/errors";

type BuildAppOptions = {
  config?: AppConfig;
  logger?: boolean | FastifyBaseLogger;
  prisma?: ReturnType<typeof createPrismaClient>;
};

type ValidationError = {
  message: string;
  validation?: unknown;
};

export const buildApp = async (options: BuildAppOptions = {}): Promise<FastifyInstance> => {
  const config = options.config ?? loadConfig();
  const prisma = options.prisma ?? createPrismaClient(config.databaseUrl);

  const app = Fastify({
    logger: options.logger ?? true,
    ajv: {
      customOptions: {
        allowUnionTypes: true,
      },
    },
  });

  app.decorate("config", config);
  app.decorate("prisma", prisma);

  await app.register(fastifyRateLimit, {
    global: false,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
  });

  await app.register(fastifyCors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  await app.register(fastifyJwt, {
    secret: config.jwtAccessSecret,
  });

  registerAuthDecorator(app);

  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(favoritesRoutes);
  await app.register(playlistsRoutes);
  await app.register(settingsRoutes);
  await app.register(historyRoutes);
  await app.register(tracksRoutes);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.code,
        message: error.message,
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.status(409).send({
        statusCode: 409,
        error: "CONFLICT",
        message: "Resource already exists.",
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return reply.status(404).send({
        statusCode: 404,
        error: "NOT_FOUND",
        message: "Requested resource was not found.",
      });
    }

    const validationError = error as ValidationError;

    if (validationError.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: "BAD_REQUEST",
        message: validationError.message,
      });
    }

    app.log.error(error);

    return reply.status(500).send({
      statusCode: 500,
      error: "INTERNAL_SERVER_ERROR",
      message: "Internal server error.",
    });
  });

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
};
