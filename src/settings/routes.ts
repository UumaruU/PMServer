import type { FastifyPluginAsync } from "fastify";
import { RepeatMode } from "@prisma/client";

import { DEFAULT_USER_SETTINGS } from "../constants";

const updateSettingsBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    language: { type: "string", minLength: 2, maxLength: 10 },
    volume: { type: "integer", minimum: 0, maximum: 100 },
    repeatMode: { type: "string", enum: Object.values(RepeatMode) },
    muted: { type: "boolean" },
    shuffleEnabled: { type: "boolean" },
  },
} as const;

const syncSettingsBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["settings"],
  properties: {
    settings: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        volume: { type: "number", minimum: 0, maximum: 1 },
        muted: { type: "boolean" },
        repeatMode: { type: "string", enum: ["off", "one", "all"] },
        shuffleEnabled: { type: "boolean" },
      },
    },
  },
} as const;

const repeatModeToSync: Record<RepeatMode, "off" | "one" | "all"> = {
  OFF: "off",
  ONE: "one",
  ALL: "all",
};

const repeatModeFromSync: Record<"off" | "one" | "all", RepeatMode> = {
  off: RepeatMode.OFF,
  one: RepeatMode.ONE,
  all: RepeatMode.ALL,
};

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const getSettings = async (userId: string) =>
    app.prisma.userSettings.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        ...DEFAULT_USER_SETTINGS,
      },
      update: {},
    });

  const patchSettings = async (
    userId: string,
    body: {
      language?: string;
      volume?: number;
      repeatMode?: RepeatMode;
      muted?: boolean;
      shuffleEnabled?: boolean;
    },
  ) =>
    app.prisma.userSettings.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        ...DEFAULT_USER_SETTINGS,
        ...body,
      },
      update: body,
    });

  app.get(
    "/me/settings",
    {
      preHandler: [app.authenticate],
    },
    async (request) => getSettings(request.authUser!.userId),
  );

  app.patch(
    "/me/settings",
    {
      preHandler: [app.authenticate],
      schema: {
        body: updateSettingsBodySchema,
      },
    },
    async (request) =>
      patchSettings(
        request.authUser!.userId,
        request.body as {
          language?: string;
          volume?: number;
          repeatMode?: RepeatMode;
          muted?: boolean;
          shuffleEnabled?: boolean;
        },
      ),
  );

  app.get(
    "/sync/settings",
    {
      preHandler: [app.authenticate],
    },
    async (request) => {
      const settings = (await getSettings(request.authUser!.userId)) as {
        volume: number;
        muted?: boolean;
        repeatMode: RepeatMode;
        shuffleEnabled: boolean;
      };

      return {
        settings: {
          volume: settings.volume / 100,
          muted: settings.muted ?? false,
          repeatMode: repeatModeToSync[settings.repeatMode],
          shuffleEnabled: settings.shuffleEnabled,
        },
      };
    },
  );

  app.put(
    "/sync/settings",
    {
      preHandler: [app.authenticate],
      schema: {
        body: syncSettingsBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        settings: {
          volume?: number;
          muted?: boolean;
          repeatMode?: "off" | "one" | "all";
          shuffleEnabled?: boolean;
        };
      };

      await patchSettings(request.authUser!.userId, {
        ...(body.settings.volume !== undefined
          ? { volume: Math.max(0, Math.min(100, Math.round(body.settings.volume * 100))) }
          : {}),
        ...(body.settings.muted !== undefined ? { muted: body.settings.muted } : {}),
        ...(body.settings.repeatMode !== undefined
          ? { repeatMode: repeatModeFromSync[body.settings.repeatMode] }
          : {}),
        ...(body.settings.shuffleEnabled !== undefined
          ? { shuffleEnabled: body.settings.shuffleEnabled }
          : {}),
      });

      return reply.code(204).send();
    },
  );
};
