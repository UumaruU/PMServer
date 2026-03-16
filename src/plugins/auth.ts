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

      request.authUser = {
        userId,
      };
    } catch (error) {
      request.log.debug({ err: error }, "Access token verification failed.");
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing access token.");
    }
  });
};
