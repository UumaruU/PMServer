import type { FastifyBaseLogger } from "fastify";
import { HistoryEventType, type PrismaClient, type Track } from "@prisma/client";

import { discoveryService } from "./discovery.service";

export type DiscoveryBackfillResult = {
  tracksIndexed: number;
  tracksSkipped: number;
  favoriteSeedsQueued: number;
  playbackSeedsQueued: number;
  playlistSeedsQueued: number;
};

type DiscoveryBackfillOptions = {
  prisma: PrismaClient;
  logger?: FastifyBaseLogger;
  batchSize?: number;
};

async function indexLegacyTracks(params: DiscoveryBackfillOptions) {
  const batchSize = Math.max(1, params.batchSize ?? 200);
  let cursor: { id: string } | undefined;
  let tracksIndexed = 0;
  let tracksSkipped = 0;

  while (true) {
    const tracks = await params.prisma.track.findMany({
      where: {
        indexedSource: null,
      },
      orderBy: [
        {
          createdAt: "asc",
        },
        {
          id: "asc",
        },
      ],
      take: batchSize,
      ...(cursor
        ? {
            cursor,
            skip: 1,
          }
        : {}),
    });

    if (!tracks.length) {
      break;
    }

    for (const track of tracks) {
      try {
        await discoveryService.ingestLegacyTrack(params.prisma, track);
        tracksIndexed += 1;
      } catch (error) {
        tracksSkipped += 1;
        params.logger?.warn(
          {
            trackId: track.id,
            source: track.source,
            sourceTrackId: track.sourceTrackId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Skipped legacy track during discovery index backfill.",
        );
      }
    }

    cursor = {
      id: tracks[tracks.length - 1].id,
    };

    if (tracks.length < batchSize) {
      break;
    }
  }

  return {
    tracksIndexed,
    tracksSkipped,
  };
}

async function queueFavoriteSeeds(params: DiscoveryBackfillOptions) {
  const favorites = await params.prisma.favorite.findMany({
    select: {
      userId: true,
      trackId: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });
  let favoriteSeedsQueued = 0;

  for (const favorite of favorites) {
    try {
      const seed = await discoveryService.enqueueFromFavorite(params.prisma, favorite.userId, favorite.trackId);
      if (seed) {
        favoriteSeedsQueued += 1;
      }
    } catch (error) {
      params.logger?.warn(
        {
          userId: favorite.userId,
          trackId: favorite.trackId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Skipped favorite during discovery seed backfill.",
      );
    }
  }

  return favoriteSeedsQueued;
}

async function queuePlaybackSeeds(params: DiscoveryBackfillOptions) {
  const historyEvents = await params.prisma.userHistoryEvent.findMany({
    where: {
      eventType: HistoryEventType.COMPLETED,
    },
    distinct: ["userId", "trackId"],
    select: {
      userId: true,
      trackId: true,
      playedMs: true,
      createdAt: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
  let playbackSeedsQueued = 0;

  for (const event of historyEvents) {
    try {
      const seed = await discoveryService.enqueueFromPlayback(params.prisma, event.userId, event.trackId, {
        source: "backfill",
        playedMs: event.playedMs ?? null,
        occurredAt: event.createdAt.toISOString(),
      });
      if (seed) {
        playbackSeedsQueued += 1;
      }
    } catch (error) {
      params.logger?.warn(
        {
          userId: event.userId,
          trackId: event.trackId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Skipped playback event during discovery seed backfill.",
      );
    }
  }

  return playbackSeedsQueued;
}

async function queuePlaylistSeeds(params: DiscoveryBackfillOptions) {
  const playlistTracks = await params.prisma.playlistTrack.findMany({
    select: {
      playlistId: true,
      trackId: true,
      playlist: {
        select: {
          userId: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });
  let playlistSeedsQueued = 0;

  for (const playlistTrack of playlistTracks) {
    try {
      const seed = await discoveryService.enqueueFromPlaylist(
        params.prisma,
        playlistTrack.playlist.userId,
        playlistTrack.playlistId,
        playlistTrack.trackId,
      );
      if (seed) {
        playlistSeedsQueued += 1;
      }
    } catch (error) {
      params.logger?.warn(
        {
          userId: playlistTrack.playlist.userId,
          playlistId: playlistTrack.playlistId,
          trackId: playlistTrack.trackId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Skipped playlist track during discovery seed backfill.",
      );
    }
  }

  return playlistSeedsQueued;
}

export async function backfillDiscoveryIndex(options: DiscoveryBackfillOptions): Promise<DiscoveryBackfillResult> {
  const trackResult = await indexLegacyTracks(options);
  const [favoriteSeedsQueued, playbackSeedsQueued, playlistSeedsQueued] = await Promise.all([
    queueFavoriteSeeds(options),
    queuePlaybackSeeds(options),
    queuePlaylistSeeds(options),
  ]);

  return {
    ...trackResult,
    favoriteSeedsQueued,
    playbackSeedsQueued,
    playlistSeedsQueued,
  };
}
