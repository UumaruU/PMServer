import type { FastifyPluginAsync } from "fastify";

import { upsertResolvedTrack, upsertResolvedTracks } from "./service";

const resolveTrackBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "sourceTrackId", "title", "artistName"],
  properties: {
    clientTrackId: { type: ["string", "null"], minLength: 1, maxLength: 255 },
    source: { type: "string", minLength: 1, maxLength: 64 },
    sourceTrackId: { type: "string", minLength: 1, maxLength: 255 },
    title: { type: "string", minLength: 1, maxLength: 255 },
    artistName: { type: "string", minLength: 1, maxLength: 255 },
    albumTitle: { type: ["string", "null"], maxLength: 255 },
    duration: { type: "integer", minimum: 0 },
    coverUrl: { type: ["string", "null"], maxLength: 2048 },
    audioUrl: { type: ["string", "null"], maxLength: 2048 },
    musicBrainzRecordingId: { type: ["string", "null"], maxLength: 64 },
    musicBrainzArtistId: { type: ["string", "null"], maxLength: 64 },
    musicBrainzReleaseId: { type: ["string", "null"], maxLength: 64 },
  },
} as const;

const resolveManyTracksBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tracks"],
  properties: {
    tracks: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: resolveTrackBodySchema,
    },
  },
} as const;

export const tracksRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/me/tracks/resolve",
    {
      preHandler: [app.authenticate],
      schema: {
        body: resolveTrackBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        clientTrackId?: string | null;
        source: string;
        sourceTrackId: string;
        title: string;
        artistName: string;
        albumTitle?: string | null;
        duration?: number;
        coverUrl?: string | null;
        audioUrl?: string | null;
        musicBrainzRecordingId?: string | null;
        musicBrainzArtistId?: string | null;
        musicBrainzReleaseId?: string | null;
      };

      const track = await upsertResolvedTrack(app.prisma, {
        clientTrackId: body.clientTrackId,
        source: body.source,
        sourceTrackId: body.sourceTrackId,
        title: body.title,
        artistName: body.artistName,
        albumTitle: body.albumTitle ?? null,
        duration: body.duration ?? null,
        coverUrl: body.coverUrl ?? null,
        audioUrl: body.audioUrl ?? null,
        musicBrainzRecordingId: body.musicBrainzRecordingId ?? null,
        musicBrainzArtistId: body.musicBrainzArtistId ?? null,
        musicBrainzReleaseId: body.musicBrainzReleaseId ?? null,
      });

      return reply.code(200).send({
        track,
      });
    },
  );

  app.post(
    "/me/tracks/resolve-many",
    {
      preHandler: [app.authenticate],
      schema: {
        body: resolveManyTracksBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        tracks: Array<{
          clientTrackId?: string | null;
          source: string;
          sourceTrackId: string;
          title: string;
          artistName: string;
          albumTitle?: string | null;
          duration?: number | null;
          coverUrl?: string | null;
          audioUrl?: string | null;
          musicBrainzRecordingId?: string | null;
          musicBrainzArtistId?: string | null;
          musicBrainzReleaseId?: string | null;
        }>;
      };

      const tracks = await upsertResolvedTracks(app.prisma, body.tracks);

      return reply.code(200).send({
        count: tracks.length,
      });
    },
  );
};
