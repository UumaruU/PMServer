import type { FastifyInstance } from "fastify";

import { AppError } from "../utils/errors";

export const registerAuthDecorator = (app: FastifyInstance): void => {
  app.decorateRequest("authUser", null);
  app.decorate("authenticate", async (request) => {
    try {
      const payload = await request.jwtVerify<{ sub?: string }>();
      const userId = payload.sub;

      if (!userId) {
        throw new Error("Missing JWT subject.");
      }

      const user = await app.prisma.user.findUnique({
        where: {
          id: userId,
        },
        select: {
          id: true,
        },
      });

      if (!user) {
        throw new Error("User not found for verified JWT subject.");
      }

      request.authUser = {
        userId,
      };
    } catch (error) {
      request.log.debug({ err: error }, "Access token verification failed.");
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing access token.");
    }
  });
  app.decorate("requireAdmin", async (request) => {
    const configuredToken = app.config.adminApiToken;
    const providedToken = request.headers["x-admin-token"];
    const token = Array.isArray(providedToken) ? providedToken[0] : providedToken;

    if (!configuredToken || token !== configuredToken) {
      throw new AppError(403, "FORBIDDEN", "Admin access is required.");
    }
  });
};
