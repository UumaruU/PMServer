import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config";

export type AuthUser = {
  userId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }

  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
    authenticate: preHandlerHookHandler;
  }
}

export type AuthenticatedRequest = FastifyRequest & {
  authUser: AuthUser;
};

export type RouteHandler<TRequest extends FastifyRequest = FastifyRequest> = (
  request: TRequest,
  reply: FastifyReply,
) => Promise<unknown>;
