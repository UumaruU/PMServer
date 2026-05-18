import { Prisma, type PrismaClient, type Track } from "@prisma/client";

import { createDeezerProvider } from "./providers/deezer.provider";
import { createHitmosProvider } from "./providers/hitmos.provider";
import { createLastfmProvider } from "./providers/lastfm.provider";
import { createListenBrainzProvider } from "./providers/listenbrainz.provider";
import { createLmusicProvider } from "./providers/lmusic.provider";
import { createMusicBrainzProvider } from "./providers/musicbrainz.provider";
import { createSoundcloudProvider } from "./providers/soundcloud.provider";
import type { DiscoveryProvider } from "./providers/provider.types";
import type { DiscoveryContext, DiscoveryJobType, DiscoverySeedReason } from "./discovery.types";
import { claimNextDiscoveryJob, enqueueDiscoveryJob } from "./discoveryQueue";
import { expandFromCanonicalTrack } from "./candidateExpansion";
import { ensureCanonicalTrackForLegacyTrack } from "./seedBuilder";
import { createDiscoveryDedupeKey, indexGrowthController } from "./indexGrowthController";
import { ingestTrack } from "./ingestion/ingestTrack";

let providerOverride: DiscoveryProvider[] | null = null;

function getBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildProviders() {
  if (providerOverride) {
    return providerOverride;
  }

  return [
    createMusicBrainzProvider(),
    createLastfmProvider(process.env.LASTFM_API_KEY),
    createDeezerProvider(process.env.DEEZER_API_BASE_URL ?? "https://api.deezer.com"),
    createListenBrainzProvider(process.env.LISTENBRAINZ_API_BASE_URL ?? "https://api.listenbrainz.org/1"),
    createHitmosProvider(),
    createLmusicProvider(),
    createSoundcloudProvider(getBooleanEnv("SOUNDCLOUD_PROVIDER_ENABLED", false)),
  ].filter((provider): provider is DiscoveryProvider => !!provider);
}

async function getLegacyTrack(prisma: PrismaClient, trackId: string) {
  return prisma.track.findUnique({
    where: {
      id: trackId,
    },
  });
}

async function enqueueMissingJobs(params: {
  prisma: PrismaClient;
  seedId: string;
  canonicalTrackId: string;
  artistId?: string | null;
  reason: DiscoverySeedReason;
  jobs: Array<{ jobType: DiscoveryJobType; priority: number }>;
}) {
  await Promise.all(
    params.jobs.map(async (job) => {
      const existingJob = await params.prisma.discoveryJob.findFirst({
        where: {
          seedId: params.seedId,
          jobType: job.jobType,
          status: {
            in: ["PENDING", "RUNNING"],
          },
        },
      });

      if (existingJob) {
        return null;
      }

      return enqueueDiscoveryJob(params.prisma, {
        seedId: params.seedId,
        jobType: job.jobType,
        priority: job.priority,
        dedupeKey: `seed:${params.seedId}:${job.jobType}`,
        rateLimitKey: `seed:${params.seedId}`,
        payload: {
          canonicalTrackId: params.canonicalTrackId,
          artistId: params.artistId ?? null,
          reason: params.reason,
        },
      });
    }),
  );
}

async function upsertDiscoverySeed(params: {
  prisma: PrismaClient;
  userId: string;
  legacyTrackId: string;
  canonicalTrackId: string;
  artistId?: string | null;
  reason: DiscoverySeedReason;
  context?: Prisma.InputJsonValue;
}) {
  const dedupeKey = createDiscoveryDedupeKey({
    scope: "user",
    userId: params.userId,
    reason: params.reason,
    targetType: "track",
    targetId: params.canonicalTrackId,
  });
  return params.prisma.discoverySeed.upsert({
    where: {
      userId_canonicalTrackId_reason: {
        userId: params.userId,
        canonicalTrackId: params.canonicalTrackId,
        reason: params.reason,
      },
    },
    create: {
      userId: params.userId,
      scope: "user",
      dedupeKey,
      legacyTrackId: params.legacyTrackId,
      canonicalTrackId: params.canonicalTrackId,
      artistId: params.artistId ?? null,
      reason: params.reason,
      context: params.context ?? Prisma.JsonNull,
    },
    update: {
      legacyTrackId: params.legacyTrackId,
      artistId: params.artistId ?? null,
      dedupeKey,
      context: params.context ?? Prisma.JsonNull,
    },
  });
}

async function createSeedForTrack(params: {
  prisma: PrismaClient;
  userId: string;
  trackId: string;
  reason: DiscoverySeedReason;
  context?: Prisma.InputJsonValue;
}) {
  const track = await getLegacyTrack(params.prisma, params.trackId);
  if (!track) {
    return null;
  }

  const canonicalTrack = await ensureCanonicalTrackForLegacyTrack(params.prisma, track);
  const artistId = canonicalTrack.artists[0]?.id ?? null;
  const seed = await upsertDiscoverySeed({
    prisma: params.prisma,
    userId: params.userId,
    legacyTrackId: track.id,
    canonicalTrackId: canonicalTrack.id,
    artistId,
    reason: params.reason,
    context: params.context,
  });
  await enqueueMissingJobs({
    prisma: params.prisma,
    seedId: seed.id,
    canonicalTrackId: canonicalTrack.id,
    artistId,
    reason: params.reason,
    jobs: [
      { jobType: "find_similar_artists", priority: 10 },
      { jobType: "resolve_artist", priority: 8 },
      { jobType: "enrich_track_metadata", priority: 7 },
      { jobType: "resolve_playable_variants", priority: 6 },
      { jobType: "update_track_edges", priority: 4 },
    ],
  });

  if (artistId) {
    const artistReason =
      params.reason === "favorite" ? "favorite_artist" : params.reason === "playlist" ? "playlist_artist" : "playback_artist";
    const artistSeed = await upsertDiscoverySeed({
      prisma: params.prisma,
      userId: params.userId,
      legacyTrackId: track.id,
      canonicalTrackId: canonicalTrack.id,
      artistId,
      reason: artistReason,
      context: params.context,
    });
    await enqueueMissingJobs({
      prisma: params.prisma,
      seedId: artistSeed.id,
      canonicalTrackId: canonicalTrack.id,
      artistId,
      reason: artistReason,
      jobs: [
        { jobType: "find_similar_artists", priority: 9 },
        { jobType: "fetch_related_artist_top_tracks", priority: 8 },
        { jobType: "fetch_artist_top_tracks", priority: 5 },
        { jobType: "fetch_artist_latest_releases", priority: 5 },
        { jobType: "update_artist_similarity", priority: 4 },
      ],
    });
  }

  if (params.reason === "favorite") {
    await Promise.all(
      canonicalTrack.tags.slice(0, 6).map(async (tag) => {
        const tagSeed = await params.prisma.discoverySeed.create({
          data: {
            userId: params.userId,
            legacyTrackId: track.id,
            canonicalTrackId: canonicalTrack.id,
            artistId,
            reason: "favorite_tag",
            context: {
              tag,
              sourceReason: params.reason,
            },
          },
        });
        await enqueueMissingJobs({
          prisma: params.prisma,
          seedId: tagSeed.id,
          canonicalTrackId: canonicalTrack.id,
          artistId,
          reason: "favorite_tag",
          jobs: [{ jobType: "find_tag_top_tracks", priority: 6 }],
        });
      }),
    );
  }

  return seed;
}

async function countEligibleCandidates(prisma: PrismaClient, context: DiscoveryContext) {
  const excluded = new Set([...(context.favoritedTrackIds ?? []), ...(context.recentTrackIds ?? [])]);
  const favoriteArtistIds = new Set(
    [
      ...(
        await prisma.canonicalTrack.findMany({
          where: {
            id: {
              in: context.favoritedTrackIds ?? [],
            },
          },
          select: {
            artists: {
              select: {
                id: true,
              },
              take: 1,
            },
          },
        })
      )
        .map((track) => track.artists[0]?.id)
        .filter((artistId): artistId is string => !!artistId),
      ...(context.userFeatures?.topArtists ?? []).filter((entry) => entry.score >= 8).map((entry) => entry.id),
    ],
  );
  const tracks = await prisma.canonicalTrack.findMany({
    where: {
      indexStatus: {
        in: ["ACTIVE", "TRUSTED"],
      },
      sources: {
        some: {
          isPlayable: true,
          indexStatus: {
            in: ["ACTIVE", "TRUSTED"],
          },
        },
      },
    },
    select: {
      id: true,
      artists: {
        select: {
          id: true,
        },
        take: 1,
      },
    },
    take: 50,
  });

  return tracks.filter((track) => {
    if (excluded.has(track.id)) {
      return false;
    }

    const primaryArtistId = track.artists[0]?.id;
    return !primaryArtistId || !favoriteArtistIds.has(primaryArtistId);
  }).length;
}

async function expandFromArtistTarget(params: {
  prisma: PrismaClient;
  providers: DiscoveryProvider[];
  artistId: string;
  discoveredFrom: string;
}) {
  const artist = await params.prisma.artist.findUnique({
    where: {
      id: params.artistId,
    },
  });
  if (!artist) {
    return {
      ingestedTrackIds: [],
      providerCalls: 0,
    };
  }

  const ingestedTrackIds: string[] = [];
  let providerCalls = 0;
  for (const provider of params.providers.filter((entry) => !!entry.getArtistTopTracks)) {
    providerCalls += 1;
    const tracks = await provider.getArtistTopTracks!(
      {
        artistId: artist.id,
        musicBrainzArtistId: artist.musicBrainzArtistId,
        name: artist.name,
      },
      8,
    ).catch(() => []);

    for (const track of tracks) {
      const ingested = await ingestTrack(params.prisma, {
        track,
        discoveredFrom: params.discoveredFrom,
      });
      ingestedTrackIds.push(ingested.canonicalTrack.id);
    }

    if (ingestedTrackIds.length) {
      break;
    }
  }

  return {
    ingestedTrackIds: [...new Set(ingestedTrackIds)],
    providerCalls,
  };
}

async function expandFromTagTarget(params: {
  prisma: PrismaClient;
  providers: DiscoveryProvider[];
  tag: string;
  discoveredFrom: string;
}) {
  const normalizedTag = params.tag === "global" ? "pop" : params.tag.replace(/^tag:/, "");
  const ingestedTrackIds: string[] = [];
  let providerCalls = 0;

  for (const provider of params.providers.filter((entry) => !!entry.getTagTopTracks)) {
    providerCalls += 1;
    const tracks = await provider.getTagTopTracks!(normalizedTag, 10).catch(() => []);

    for (const track of tracks) {
      const ingested = await ingestTrack(params.prisma, {
        track,
        discoveredFrom: params.discoveredFrom,
      });
      ingestedTrackIds.push(ingested.canonicalTrack.id);
    }

    if (ingestedTrackIds.length) {
      break;
    }
  }

  return {
    ingestedTrackIds: [...new Set(ingestedTrackIds)],
    providerCalls,
  };
}

async function processDiscoveryTargetJob(params: {
  prisma: PrismaClient;
  providers: DiscoveryProvider[];
  payload: {
    canonicalTrackId?: string;
    targetType?: string;
    targetId?: string;
    artistId?: string | null;
  };
  discoveredFrom: string;
}) {
  if (params.payload.canonicalTrackId) {
    const seedTrack = await params.prisma.canonicalTrack.findUnique({
      where: {
        id: params.payload.canonicalTrackId,
      },
      include: {
        artists: true,
      },
    });

    if (!seedTrack) {
      throw new Error("Discovery job seed track not found.");
    }

    return expandFromCanonicalTrack({
      prisma: params.prisma,
      providers: params.providers,
      seedTrack,
      discoveredFrom: params.discoveredFrom,
    });
  }

  if (params.payload.targetType === "artist" && params.payload.targetId) {
    return expandFromArtistTarget({
      prisma: params.prisma,
      providers: params.providers,
      artistId: params.payload.targetId,
      discoveredFrom: params.discoveredFrom,
    });
  }

  if (
    (params.payload.targetType === "tag" ||
      params.payload.targetType === "genre" ||
      params.payload.targetType === "scene" ||
      params.payload.targetType === "country_language") &&
    params.payload.targetId
  ) {
    return expandFromTagTarget({
      prisma: params.prisma,
      providers: params.providers,
      tag: params.payload.targetId,
      discoveredFrom: params.discoveredFrom,
    });
  }

  if (params.payload.artistId) {
    return expandFromArtistTarget({
      prisma: params.prisma,
      providers: params.providers,
      artistId: params.payload.artistId,
      discoveredFrom: params.discoveredFrom,
    });
  }

  return {
    ingestedTrackIds: [],
    providerCalls: 0,
  };
}

async function resolveExpansionSeed(prisma: PrismaClient, userId: string, context: DiscoveryContext) {
  const directId = context.currentCanonicalTrackId ?? context.favoritedTrackIds?.[0] ?? context.recentTrackIds?.[0] ?? null;
  if (directId) {
    const direct = await prisma.canonicalTrack.findUnique({
      where: {
        id: directId,
      },
      include: {
        artists: true,
      },
    });
    if (direct) {
      return direct;
    }
  }

  const seed = await prisma.discoverySeed.findFirst({
    where: {
      userId,
      canonicalTrackId: {
        not: null,
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    include: {
      canonicalTrack: {
        include: {
          artists: true,
        },
      },
    },
  });

  return seed?.canonicalTrack ?? null;
}

async function resolveExpansionSeeds(prisma: PrismaClient, userId: string, context: DiscoveryContext) {
  const directIds = [
    context.currentCanonicalTrackId,
    ...(context.favoritedTrackIds ?? []),
    ...(context.recentTrackIds ?? []),
  ].filter((trackId): trackId is string => !!trackId);
  const seedRows = await prisma.discoverySeed.findMany({
    where: {
      userId,
      canonicalTrackId: {
        not: null,
      },
    },
    orderBy: [
      {
        updatedAt: "desc",
      },
      {
        id: "asc",
      },
    ],
    take: 24,
    include: {
      canonicalTrack: {
        include: {
          artists: true,
        },
      },
    },
  });
  const seedIds = [
    ...directIds,
    ...seedRows.map((seed) => seed.canonicalTrackId).filter((trackId): trackId is string => !!trackId),
  ];

  if (!seedIds.length) {
    return [];
  }

  const tracks = await prisma.canonicalTrack.findMany({
    where: {
      id: {
        in: [...new Set(seedIds)],
      },
    },
    include: {
      artists: true,
    },
  });
  const byId = new Map(tracks.map((track) => [track.id, track] as const));
  const result: typeof tracks = [];
  const seenArtistIds = new Set<string>();

  for (const trackId of seedIds) {
    const track = byId.get(trackId);
    if (!track) {
      continue;
    }

    const primaryArtistId = track.artists[0]?.id ?? `track:${track.id}`;
    if (seenArtistIds.has(primaryArtistId)) {
      continue;
    }

    seenArtistIds.add(primaryArtistId);
    result.push(track);

    if (result.length >= 5) {
      break;
    }
  }

  return result;
}

export const discoveryService = {
  setProvidersForTesting(providers: DiscoveryProvider[]) {
    providerOverride = providers;
  },

  resetProvidersForTesting() {
    providerOverride = null;
  },

  async ingestLegacyTrack(prisma: PrismaClient, track: Track) {
    return ensureCanonicalTrackForLegacyTrack(prisma, track);
  },

  async enqueueFromFavorite(prisma: PrismaClient, userId: string, trackId: string) {
    return createSeedForTrack({
      prisma,
      userId,
      trackId,
      reason: "favorite",
    });
  },

  async enqueueFromPlayback(
    prisma: PrismaClient,
    userId: string,
    trackId: string,
    playback: Prisma.InputJsonValue,
  ) {
    return createSeedForTrack({
      prisma,
      userId,
      trackId,
      reason: "playback",
      context: playback,
    });
  },

  async enqueueFromPlaylist(prisma: PrismaClient, userId: string, playlistId: string, trackId: string) {
    return createSeedForTrack({
      prisma,
      userId,
      trackId,
      reason: "playlist",
      context: {
        playlistId,
      },
    });
  },

  async ensureCandidatePool(prisma: PrismaClient, userId: string, context: DiscoveryContext) {
    const liveExpansionEnabled = getBooleanEnv("DISCOVERY_LIVE_EXPANSION_ENABLED", true);
    const result = await indexGrowthController.ensureHealthyPool(prisma, userId, context, {
      liveExpansionLimit: getNumberEnv("DISCOVERY_MAX_LIVE_PROVIDER_CALLS", 8),
      liveExpansionRunner: liveExpansionEnabled
        ? (limit) => this.runLiveExpansion(prisma, userId, context, limit)
        : async () => ({ ingestedTrackIds: [], providerCalls: 0 }),
    });

    return {
      expanded: (result.liveExpansion?.ingestedTrackIds.length ?? 0) > 0,
      existingCount: result.health.relevantPlayableTracks,
      poolLevel: result.poolLevel,
      health: result.health,
      queuedJobs: result.queuedJobs,
      ingestedTrackIds: result.liveExpansion?.ingestedTrackIds ?? [],
    };
  },

  async runLiveExpansion(prisma: PrismaClient, userId: string, context: DiscoveryContext, limit = 3) {
    const seedTracks = await resolveExpansionSeeds(prisma, userId, context);
    if (!seedTracks.length) {
      const seedTrack = await resolveExpansionSeed(prisma, userId, context);
      if (!seedTrack) {
        return {
          ingestedTrackIds: [],
          providerCalls: 0,
        };
      }

      seedTracks.push(seedTrack);
    }

    const providers = buildProviders();
    const ingestedTrackIds: string[] = [];
    let providerCalls = 0;

    for (const seedTrack of seedTracks) {
      if (providerCalls >= limit) {
        break;
      }

      const result = await expandFromCanonicalTrack({
        prisma,
        providers,
        seedTrack,
        providerCallLimit: Math.max(1, limit - providerCalls),
        discoveredFrom: "live_expansion",
      });
      providerCalls += result.providerCalls;
      ingestedTrackIds.push(...result.ingestedTrackIds);

      if (ingestedTrackIds.length >= 3) {
        break;
      }
    }

    if (!providerCalls) {
      return {
        ingestedTrackIds: [],
        providerCalls: 0,
      };
    }

    return {
      ingestedTrackIds: [...new Set(ingestedTrackIds)],
      providerCalls,
    };
  },

  async processNextDiscoveryJob(prisma: PrismaClient) {
    const job = await claimNextDiscoveryJob(prisma);
    if (!job) {
      return null;
    }

    try {
      const payload = job.payload as {
        canonicalTrackId?: string;
        targetType?: string;
        targetId?: string;
        artistId?: string | null;
      };

      const result = await processDiscoveryTargetJob({
        prisma,
        providers: buildProviders(),
        payload,
        discoveredFrom: job.jobType,
      });

      return prisma.discoveryJob.update({
        where: {
          id: job.id,
        },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          result: result as unknown as Prisma.InputJsonValue,
          error: null,
        },
      });
    } catch (error) {
      const shouldRetry = job.attempts < job.maxAttempts;
      return prisma.discoveryJob.update({
        where: {
          id: job.id,
        },
        data: {
          status: shouldRetry ? "PENDING" : "FAILED",
          error: error instanceof Error ? error.message : "Unknown discovery job failure.",
          runAfter: new Date(Date.now() + 60_000),
        },
      });
    }
  },
};
