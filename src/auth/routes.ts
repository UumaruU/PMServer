import type { FastifyPluginAsync } from "fastify";

import { serializeUser } from "../users/serializers";
import { createUser, authenticateUser, issueTokens, refreshAccessToken, revokeRefreshToken } from "./service";

const registerBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8, maxLength: 128 },
    username: { type: "string", minLength: 3, maxLength: 32 },
    name: { type: "string", minLength: 1, maxLength: 120 },
    deviceName: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

const loginBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8, maxLength: 128 },
    deviceName: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

const refreshBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["refreshToken"],
  properties: {
    refreshToken: { type: "string", minLength: 1 },
  },
} as const;

const logoutBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    refreshToken: { type: "string", minLength: 1 },
  },
} as const;

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/register",
    {
      schema: {
        body: registerBodySchema,
      },
      config: {
        rateLimit: {
          max: app.config.rateLimitMax,
          timeWindow: app.config.rateLimitWindow,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        password: string;
        username?: string;
        name?: string;
        deviceName?: string;
      };

      const user = await createUser(app.prisma, body);
      const tokens = await issueTokens(app.prisma, app.config, user, body.deviceName);

      return reply.code(201).send({
        ...tokens,
        user: serializeUser(user),
      });
    },
  );

  app.post(
    "/auth/login",
    {
      schema: {
        body: loginBodySchema,
      },
      config: {
        rateLimit: {
          max: app.config.rateLimitMax,
          timeWindow: app.config.rateLimitWindow,
        },
      },
    },
    async (request) => {
      const body = request.body as {
        email: string;
        password: string;
        deviceName?: string;
      };

      const user = await authenticateUser(app.prisma, body);
      const tokens = await issueTokens(app.prisma, app.config, user, body.deviceName);

      return {
        ...tokens,
        user: serializeUser(user),
      };
    },
  );

  app.post(
    "/auth/refresh",
    {
      schema: {
        body: refreshBodySchema,
      },
      config: {
        rateLimit: {
          max: app.config.rateLimitMax,
          timeWindow: app.config.rateLimitWindow,
        },
      },
    },
    async (request) => {
      const body = request.body as { refreshToken: string };
      const accessToken = await refreshAccessToken(app.prisma, app.config, body.refreshToken);

      return {
        accessToken,
      };
    },
  );

  app.post(
    "/auth/logout",
    {
      schema: {
        body: logoutBodySchema,
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { refreshToken?: string };
      await revokeRefreshToken(app.prisma, app.config, body.refreshToken);

      return reply.code(204).send();
    },
  );

  app.get(
    "/auth/me",
    {
      preHandler: [app.authenticate],
    },
    async (request) => {
      const user = await app.prisma.user.findUniqueOrThrow({
        where: {
          id: request.authUser!.userId,
        },
      });

      return {
        user: serializeUser(user),
      };
    },
  );
};
