import type { FastifyPluginAsync } from "fastify";

const resolveTrackBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "sourceTrackId", "title", "artistName"],
  properties: {
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

      const track = await app.prisma.track.upsert({
        where: {
          source_sourceTrackId: {
            source: body.source,
            sourceTrackId: body.sourceTrackId,
          },
        },
        create: {
          source: body.source,
          sourceTrackId: body.sourceTrackId,
          title: body.title,
          artistName: body.artistName,
          albumTitle: body.albumTitle ?? null,
          duration: body.duration,
          coverUrl: body.coverUrl ?? null,
          audioUrl: body.audioUrl ?? null,
          musicBrainzRecordingId: body.musicBrainzRecordingId ?? null,
          musicBrainzArtistId: body.musicBrainzArtistId ?? null,
          musicBrainzReleaseId: body.musicBrainzReleaseId ?? null,
        },
        update: {
          title: body.title,
          artistName: body.artistName,
          albumTitle: body.albumTitle ?? null,
          duration: body.duration,
          coverUrl: body.coverUrl ?? null,
          audioUrl: body.audioUrl ?? null,
          musicBrainzRecordingId: body.musicBrainzRecordingId ?? null,
          musicBrainzArtistId: body.musicBrainzArtistId ?? null,
          musicBrainzReleaseId: body.musicBrainzReleaseId ?? null,
        },
      });

      return reply.code(200).send({
        track,
      });
    },
  );
};
