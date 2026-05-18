import { Prisma, type PrismaClient } from "@prisma/client";

import type { DiscoveryContext, DiscoveryJobType, DiscoverySeedReason } from "./discovery.types";
import { enqueueDiscoveryJob } from "./discoveryQueue";

type PoolMetricThresholds = {
  minRelevantPlayableTracks: number;
  minDistinctArtists: number;
  minDistinctClusters: number;
  minFreshReleases: number;
  maxSameArtistShare: number;
  maxPendingJobs: number;
  maxStaleMetadataShare: number;
};

export type IndexGrowthThresholds = {
  emergencyPool: PoolMetricThresholds;
  minimumViablePool: PoolMetricThresholds;
  healthyPool: PoolMetricThresholds;
  richPool: PoolMetricThresholds;
};

export type PoolLevel = "emergencyPool" | "minimumViablePool" | "healthyPool" | "richPool";

export type IndexGrowthSeedReason =
  | "liked_artist"
  | "liked_track"
  | "completed_listen"
  | "playlist_track"
  | "opened_artist"
  | "user_top_tag"
  | "similar_artist"
  | "adjacent_genre"
  | "trending_artist_by_genre"
  | "new_release"
  | "collaborator_feature"
  | "popular_artist_by_genre"
  | "top_track_by_tag"
  | "trending_artist"
  | "country_language_chart"
  | "long_tail_active_scene";

export type DiscoveryTargetType =
  | "track"
  | "artist"
  | "tag"
  | "genre"
  | "release"
  | "scene"
  | "country_language";

export interface CandidatePoolHealth {
  relevantPlayableTracks: number;
  distinctArtists: number;
  distinctClusters: number;
  freshReleases: number;
  sameArtistShare: number;
  pendingJobs: number;
  staleMetadataShare: number;
  stalePlayableSourceShare: number;
  suppressedByCooldown: {
    artistIds: string[];
    tagIds: string[];
    clusterIds: string[];
  };
}

export interface IndexGrowthSeedSpec {
  scope: "user" | "global";
  userId?: string | null;
  reason: IndexGrowthSeedReason;
  targetType: DiscoveryTargetType;
  targetId: string;
  priority: number;
  context: Record<string, unknown>;
  jobTypes: DiscoveryJobType[];
}

export interface IndexGrowthPlan {
  poolLevel: PoolLevel;
  shouldRunLiveExpansion: boolean;
  shouldQueueBackgroundExpansion: boolean;
  priority: number;
  userSeeds: IndexGrowthSeedSpec[];
}

export interface LiveExpansionResult {
  ingestedTrackIds: string[];
  providerCalls: number;
}

export interface EnsureHealthyPoolResult {
  health: CandidatePoolHealth;
  poolLevel: PoolLevel;
  plan: IndexGrowthPlan;
  liveExpansion: LiveExpansionResult | null;
  queuedJobs: number;
}

export const defaultIndexGrowthThresholds: IndexGrowthThresholds = {
  emergencyPool: {
    minRelevantPlayableTracks: 4,
    minDistinctArtists: 2,
    minDistinctClusters: 2,
    minFreshReleases: 0,
    maxSameArtistShare: 0.9,
    maxPendingJobs: 80,
    maxStaleMetadataShare: 1,
  },
  minimumViablePool: {
    minRelevantPlayableTracks: 12,
    minDistinctArtists: 4,
    minDistinctClusters: 3,
    minFreshReleases: 1,
    maxSameArtistShare: 0.75,
    maxPendingJobs: 60,
    maxStaleMetadataShare: 0.85,
  },
  healthyPool: {
    minRelevantPlayableTracks: 30,
    minDistinctArtists: 12,
    minDistinctClusters: 6,
    minFreshReleases: 3,
    maxSameArtistShare: 0.5,
    maxPendingJobs: 40,
    maxStaleMetadataShare: 0.5,
  },
  richPool: {
    minRelevantPlayableTracks: 80,
    minDistinctArtists: 30,
    minDistinctClusters: 12,
    minFreshReleases: 8,
    maxSameArtistShare: 0.3,
    maxPendingJobs: 16,
    maxStaleMetadataShare: 0.25,
  },
};

function thresholdFromEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadIndexGrowthThresholds(): IndexGrowthThresholds {
  const base = defaultIndexGrowthThresholds;

  return {
    emergencyPool: {
      ...base.emergencyPool,
      minRelevantPlayableTracks: thresholdFromEnv(
        "DISCOVERY_EMERGENCY_POOL_TRACKS",
        base.emergencyPool.minRelevantPlayableTracks,
      ),
      minDistinctArtists: thresholdFromEnv(
        "DISCOVERY_EMERGENCY_POOL_ARTISTS",
        base.emergencyPool.minDistinctArtists,
      ),
    },
    minimumViablePool: {
      ...base.minimumViablePool,
      minRelevantPlayableTracks: thresholdFromEnv(
        "DISCOVERY_MINIMUM_VIABLE_POOL_TRACKS",
        base.minimumViablePool.minRelevantPlayableTracks,
      ),
      minDistinctArtists: thresholdFromEnv(
        "DISCOVERY_MINIMUM_VIABLE_POOL_ARTISTS",
        base.minimumViablePool.minDistinctArtists,
      ),
    },
    healthyPool: {
      ...base.healthyPool,
      minRelevantPlayableTracks: thresholdFromEnv("DISCOVERY_HEALTHY_POOL_TRACKS", base.healthyPool.minRelevantPlayableTracks),
      minDistinctArtists: thresholdFromEnv("DISCOVERY_HEALTHY_POOL_ARTISTS", base.healthyPool.minDistinctArtists),
    },
    richPool: {
      ...base.richPool,
      minRelevantPlayableTracks: thresholdFromEnv("DISCOVERY_RICH_POOL_TRACKS", base.richPool.minRelevantPlayableTracks),
      minDistinctArtists: thresholdFromEnv("DISCOVERY_RICH_POOL_ARTISTS", base.richPool.minDistinctArtists),
    },
  };
}

function meetsThreshold(health: CandidatePoolHealth, threshold: PoolMetricThresholds) {
  return (
    health.relevantPlayableTracks >= threshold.minRelevantPlayableTracks &&
    health.distinctArtists >= threshold.minDistinctArtists &&
    health.distinctClusters >= threshold.minDistinctClusters &&
    health.freshReleases >= threshold.minFreshReleases &&
    health.sameArtistShare <= threshold.maxSameArtistShare &&
    health.pendingJobs <= threshold.maxPendingJobs &&
    health.staleMetadataShare <= threshold.maxStaleMetadataShare
  );
}

export function resolvePoolLevel(
  health: CandidatePoolHealth,
  thresholds: IndexGrowthThresholds = loadIndexGrowthThresholds(),
): PoolLevel {
  if (!meetsThreshold(health, thresholds.emergencyPool)) {
    return "emergencyPool";
  }

  if (!meetsThreshold(health, thresholds.minimumViablePool)) {
    return "minimumViablePool";
  }

  if (meetsThreshold(health, thresholds.richPool)) {
    return "richPool";
  }

  return "healthyPool";
}

export function createDiscoveryDedupeKey(input: {
  scope: "user" | "global";
  userId?: string | null;
  reason: string;
  targetType: string;
  targetId: string;
}) {
  return [
    input.scope,
    input.scope === "user" ? input.userId ?? "anonymous" : "global",
    input.reason,
    input.targetType,
    input.targetId,
  ]
    .map((value) => value.trim().toLowerCase())
    .join(":");
}

function levelPriority(level: PoolLevel) {
  switch (level) {
    case "emergencyPool":
      return 100;
    case "minimumViablePool":
      return 78;
    case "healthyPool":
      return 48;
    case "richPool":
      return 12;
  }
}

function cooldownAdjustedPriority(
  priority: number,
  targetType: DiscoveryTargetType,
  targetId: string,
  health: CandidatePoolHealth,
) {
  const isSuppressed =
    (targetType === "artist" && health.suppressedByCooldown.artistIds.includes(targetId)) ||
    ((targetType === "tag" || targetType === "genre" || targetType === "scene") &&
      (health.suppressedByCooldown.tagIds.includes(targetId) || health.suppressedByCooldown.clusterIds.includes(targetId)));

  return isSuppressed ? Math.max(1, Math.floor(priority * 0.35)) : priority;
}

function seedSpec(input: Omit<IndexGrowthSeedSpec, "scope"> & { scope?: "user" | "global"; health: CandidatePoolHealth }) {
  return {
    scope: input.scope ?? "user",
    userId: input.userId,
    reason: input.reason,
    targetType: input.targetType,
    targetId: input.targetId,
    priority: cooldownAdjustedPriority(input.priority, input.targetType, input.targetId, input.health),
    context: input.context,
    jobTypes: input.jobTypes,
  } satisfies IndexGrowthSeedSpec;
}

export function buildIndexGrowthPlan(params: {
  userId: string;
  poolLevel: PoolLevel;
  health: CandidatePoolHealth;
  context: DiscoveryContext;
}): IndexGrowthPlan {
  const priority = levelPriority(params.poolLevel);
  const topArtists = params.context.userFeatures?.topArtists ?? [];
  const topTags = params.context.userFeatures?.topTags ?? [];
  const userSeeds: IndexGrowthSeedSpec[] = [];

  topArtists.slice(0, 8).forEach((artist) => {
    userSeeds.push(
      seedSpec({
        userId: params.userId,
        reason: "liked_artist",
        targetType: "artist",
        targetId: artist.id,
        priority: priority - 2,
        context: { score: artist.score },
        jobTypes: [
          "find_similar_artists",
          "fetch_artist_top_tracks",
          "fetch_artist_latest_releases",
          "refresh_similarity_edges",
        ],
        health: params.health,
      }),
      seedSpec({
        userId: params.userId,
        reason: "similar_artist",
        targetType: "artist",
        targetId: artist.id,
        priority: priority - 8,
        context: { score: artist.score },
        jobTypes: ["find_similar_artists", "fetch_related_artist_top_tracks"],
        health: params.health,
      }),
      seedSpec({
        userId: params.userId,
        reason: "collaborator_feature",
        targetType: "artist",
        targetId: artist.id,
        priority: priority - 14,
        context: { score: artist.score },
        jobTypes: ["find_similar_artists", "update_artist_similarity"],
        health: params.health,
      }),
    );
  });

  (params.context.favoritedTrackIds ?? []).slice(0, 12).forEach((trackId) => {
    userSeeds.push(
      seedSpec({
        userId: params.userId,
        reason: "liked_track",
        targetType: "track",
        targetId: trackId,
        priority,
        context: {},
        jobTypes: ["find_similar_artists", "resolve_playable_variants", "update_track_edges"],
        health: params.health,
      }),
    );
  });

  (params.context.recentTrackIds ?? []).slice(0, 12).forEach((trackId) => {
    userSeeds.push(
      seedSpec({
        userId: params.userId,
        reason: "completed_listen",
        targetType: "track",
        targetId: trackId,
        priority: priority - 4,
        context: {},
        jobTypes: ["find_similar_artists", "fetch_related_artist_top_tracks", "resolve_playable_variants"],
        health: params.health,
      }),
    );
  });

  topTags.slice(0, 10).forEach((tag) => {
    userSeeds.push(
      seedSpec({
        userId: params.userId,
        reason: "user_top_tag",
        targetType: "tag",
        targetId: tag.id,
        priority: priority - 6,
        context: { score: tag.score },
        jobTypes: ["find_tag_top_tracks"],
        health: params.health,
      }),
      seedSpec({
        userId: params.userId,
        reason: "adjacent_genre",
        targetType: "genre",
        targetId: tag.id,
        priority: priority - 18,
        context: { score: tag.score },
        jobTypes: ["find_tag_top_tracks", "refresh_similarity_edges"],
        health: params.health,
      }),
      seedSpec({
        userId: params.userId,
        reason: "trending_artist_by_genre",
        targetType: "genre",
        targetId: tag.id,
        priority: priority - 20,
        context: { score: tag.score },
        jobTypes: ["find_tag_top_tracks", "refresh_artist_metadata"],
        health: params.health,
      }),
      seedSpec({
        userId: params.userId,
        reason: "new_release",
        targetType: "genre",
        targetId: tag.id,
        priority: priority - 22,
        context: { score: tag.score },
        jobTypes: ["refresh_latest_releases"],
        health: params.health,
      }),
    );
  });

  if (params.context.currentCanonicalTrackId) {
    userSeeds.push(
      seedSpec({
        userId: params.userId,
        reason: "completed_listen",
        targetType: "track",
        targetId: params.context.currentCanonicalTrackId,
        priority: priority - 5,
        context: { source: "current_track" },
        jobTypes: ["find_similar_artists", "resolve_playable_variants"],
        health: params.health,
      }),
    );
  }

  return {
    poolLevel: params.poolLevel,
    shouldRunLiveExpansion: params.poolLevel === "emergencyPool",
    shouldQueueBackgroundExpansion: params.poolLevel !== "richPool",
    priority,
    userSeeds,
  };
}

function uniqueSeeds(seeds: IndexGrowthSeedSpec[]) {
  const seen = new Set<string>();
  const result: IndexGrowthSeedSpec[] = [];

  seeds.forEach((seed) => {
    const key = createDiscoveryDedupeKey({
      scope: seed.scope,
      userId: seed.userId,
      reason: seed.reason,
      targetType: seed.targetType,
      targetId: seed.targetId,
    });
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(seed);
  });

  return result;
}

function getSeedReason(reason: IndexGrowthSeedReason): DiscoverySeedReason {
  return reason;
}

export class IndexGrowthController {
  constructor(private readonly thresholds: IndexGrowthThresholds = loadIndexGrowthThresholds()) {}

  async measurePoolHealth(prisma: PrismaClient, userId: string, context: DiscoveryContext): Promise<CandidatePoolHealth> {
    const [tracks, pendingJobs, recentSkipEvents] = await Promise.all([
      prisma.canonicalTrack.findMany({
        where: {
          indexStatus: {
            in: ["ACTIVE", "TRUSTED"] as never,
          },
          sources: {
            some: {
              isPlayable: true,
              indexStatus: {
                in: ["ACTIVE", "TRUSTED"] as never,
              },
            },
          },
        },
        include: {
          artists: {
            select: {
              id: true,
            },
            take: 3,
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
        take: 250,
      }),
      prisma.discoveryJob.count({
        where: {
          status: {
            in: ["PENDING", "RUNNING"],
          },
        },
      }),
      prisma.userRecommendationEvent.findMany({
        where: {
          userId,
          eventType: {
            in: ["SKIP", "INTERACTION", "PLAYBACK"] as never,
          },
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 100,
      }),
    ]);
    const topArtistIds = new Set((context.userFeatures?.topArtists ?? []).map((artist) => artist.id));
    const topTagIds = new Set((context.userFeatures?.topTags ?? []).map((tag) => tag.id));
    const seedTrackIds = new Set([
      context.currentCanonicalTrackId ?? "",
      ...(context.favoritedTrackIds ?? []),
      ...(context.recentTrackIds ?? []),
    ].filter(Boolean));
    const now = Date.now();
    const freshReleaseCutoffMs = now - 90 * 24 * 60 * 60 * 1000;
    const relevant = tracks.filter((track) => {
      const artistMatch = track.artists.some((artist) => topArtistIds.has(artist.id));
      const tagMatch = track.tags.some((tag) => topTagIds.has(tag));
      const seedMatch = seedTrackIds.has(track.id);

      return artistMatch || tagMatch || seedMatch || (!topArtistIds.size && !topTagIds.size);
    });
    const artistCounts = new Map<string, number>();
    const clusterIds = new Set<string>();
    let staleMetadataCount = 0;
    let stalePlayableCount = 0;
    let freshReleases = 0;

    relevant.forEach((track) => {
      const primaryArtistId = track.artists[0]?.id;
      if (primaryArtistId) {
        artistCounts.set(primaryArtistId, (artistCounts.get(primaryArtistId) ?? 0) + 1);
      }

      track.tags.slice(0, 3).forEach((tag) => clusterIds.add(tag));

      const lastProviderCheckAt = track.lastProviderCheckAt?.getTime() ?? 0;
      if (!lastProviderCheckAt || now - lastProviderCheckAt > 14 * 24 * 60 * 60 * 1000 || track.metadataFreshness < 0.4) {
        staleMetadataCount += 1;
      }

      if (track.playableSourceFreshness < 0.4) {
        stalePlayableCount += 1;
      }

      const releaseMs = track.releaseDate ? Date.parse(track.releaseDate) : 0;
      if (releaseMs && releaseMs >= freshReleaseCutoffMs) {
        freshReleases += 1;
      }
    });

    const skipPayloads = recentSkipEvents
      .map((event) => (event.payload as Record<string, unknown> | null | undefined) ?? {})
      .filter((payload) => payload.action === "skip" || payload.wasSkipped === true);
    const skippedTrackIds = new Set(
      skipPayloads
        .map((payload) => (typeof payload.canonicalTrackId === "string" ? payload.canonicalTrackId : null))
        .filter((trackId): trackId is string => !!trackId),
    );
    const skippedTracks = relevant.filter((track) => skippedTrackIds.has(track.id));
    const cooldownArtistIds = new Set<string>();
    const cooldownTagIds = new Set<string>();

    skippedTracks.forEach((track) => {
      track.artists.forEach((artist) => cooldownArtistIds.add(artist.id));
      track.tags.forEach((tag) => cooldownTagIds.add(tag));
    });

    return {
      relevantPlayableTracks: relevant.length,
      distinctArtists: artistCounts.size,
      distinctClusters: clusterIds.size,
      freshReleases,
      sameArtistShare: relevant.length ? Math.max(0, ...artistCounts.values()) / relevant.length : 1,
      pendingJobs,
      staleMetadataShare: relevant.length ? staleMetadataCount / relevant.length : 1,
      stalePlayableSourceShare: relevant.length ? stalePlayableCount / relevant.length : 1,
      suppressedByCooldown: {
        artistIds: [...cooldownArtistIds].sort(),
        tagIds: [...cooldownTagIds].sort(),
        clusterIds: [...cooldownTagIds].sort(),
      },
    };
  }

  async ensureHealthyPool(
    prisma: PrismaClient,
    userId: string,
    context: DiscoveryContext,
    options: {
      liveExpansionLimit: number;
      liveExpansionRunner: (limit: number) => Promise<LiveExpansionResult>;
    },
  ): Promise<EnsureHealthyPoolResult> {
    const health = await this.measurePoolHealth(prisma, userId, context);
    const poolLevel = resolvePoolLevel(health, this.thresholds);
    const plan = buildIndexGrowthPlan({
      userId,
      poolLevel,
      health,
      context,
    });
    const liveExpansion = plan.shouldRunLiveExpansion
      ? await this.runBoundedLiveExpansion({
          limit: options.liveExpansionLimit,
          runner: options.liveExpansionRunner,
        })
      : null;
    const queuedJobs = plan.shouldQueueBackgroundExpansion
      ? await this.enqueueUserGrowth(prisma, userId, plan.userSeeds)
      : await this.enqueueRefreshForRichPool(prisma, userId, context);

    return {
      health,
      poolLevel,
      plan,
      liveExpansion,
      queuedJobs,
    };
  }

  async enqueueUserGrowth(prisma: PrismaClient, userId: string, seeds: IndexGrowthSeedSpec[]) {
    let queuedJobs = 0;

    for (const seed of uniqueSeeds(seeds)) {
      const dedupeKey = createDiscoveryDedupeKey({
        scope: "user",
        userId,
        reason: seed.reason,
        targetType: seed.targetType,
        targetId: seed.targetId,
      });
      const discoverySeed = await this.upsertSeed(prisma, {
        ...seed,
        scope: "user",
        userId,
        dedupeKey,
      });

      queuedJobs += await this.enqueueJobsForSeed(prisma, discoverySeed.id, dedupeKey, seed);
    }

    return queuedJobs;
  }

  async enqueueGlobalBootstrap(prisma: PrismaClient, context: { tags?: string[]; genres?: string[]; countryLanguages?: string[] } = {}) {
    const tags = context.tags?.length ? context.tags : ["pop", "rock", "hip-hop", "electronic", "indie"];
    const countryLanguages = context.countryLanguages?.length ? context.countryLanguages : ["global", "us-en", "ru-ru"];
    const seeds: IndexGrowthSeedSpec[] = [
      ...tags.flatMap((tag) => [
        seedSpec({
          scope: "global",
          reason: "popular_artist_by_genre",
          targetType: "genre",
          targetId: tag,
          priority: 42,
          context: {},
          jobTypes: ["find_tag_top_tracks", "refresh_artist_metadata"],
          health: emptyHealth(),
        }),
        seedSpec({
          scope: "global",
          reason: "top_track_by_tag",
          targetType: "tag",
          targetId: tag,
          priority: 44,
          context: {},
          jobTypes: ["find_tag_top_tracks"],
          health: emptyHealth(),
        }),
        seedSpec({
          scope: "global",
          reason: "long_tail_active_scene",
          targetType: "scene",
          targetId: tag,
          priority: 24,
          context: {},
          jobTypes: ["find_tag_top_tracks"],
          health: emptyHealth(),
        }),
      ]),
      seedSpec({
        scope: "global",
        reason: "trending_artist",
        targetType: "scene",
        targetId: "global",
        priority: 46,
        context: {},
        jobTypes: ["find_tag_top_tracks", "refresh_artist_metadata"],
        health: emptyHealth(),
      }),
      seedSpec({
        scope: "global",
        reason: "new_release",
        targetType: "scene",
        targetId: "global",
        priority: 40,
        context: {},
        jobTypes: ["refresh_latest_releases"],
        health: emptyHealth(),
      }),
      ...countryLanguages.map((countryLanguage) =>
        seedSpec({
          scope: "global",
          reason: "country_language_chart",
          targetType: "country_language",
          targetId: countryLanguage,
          priority: 34,
          context: {},
          jobTypes: ["find_tag_top_tracks"],
          health: emptyHealth(),
        }),
      ),
    ];
    let queuedJobs = 0;

    for (const seed of uniqueSeeds(seeds)) {
      const dedupeKey = createDiscoveryDedupeKey({
        scope: "global",
        reason: seed.reason,
        targetType: seed.targetType,
        targetId: seed.targetId,
      });
      const discoverySeed = await this.upsertSeed(prisma, {
        ...seed,
        scope: "global",
        userId: null,
        dedupeKey,
      });

      queuedJobs += await this.enqueueJobsForSeed(prisma, discoverySeed.id, dedupeKey, seed);
    }

    return queuedJobs;
  }

  async runBoundedLiveExpansion(params: {
    limit: number;
    runner: (limit: number) => Promise<LiveExpansionResult>;
  }) {
    return params.runner(Math.max(1, params.limit));
  }

  private async enqueueRefreshForRichPool(prisma: PrismaClient, userId: string, context: DiscoveryContext) {
    const trackId = context.currentCanonicalTrackId ?? context.recentTrackIds?.[0] ?? context.favoritedTrackIds?.[0] ?? null;
    if (!trackId) {
      return 0;
    }

    return this.enqueueUserGrowth(prisma, userId, [
      seedSpec({
        userId,
        reason: "completed_listen",
        targetType: "track",
        targetId: trackId,
        priority: 8,
        context: { refreshOnly: true },
        jobTypes: ["refresh_artist_metadata", "refresh_playable_sources", "refresh_similarity_edges"],
        health: emptyHealth(),
      }),
    ]);
  }

  private async upsertSeed(
    prisma: PrismaClient,
    seed: IndexGrowthSeedSpec & { dedupeKey: string },
  ) {
    const existing = await prisma.discoverySeed.findUnique({
      where: {
        dedupeKey: seed.dedupeKey,
      },
    });
    const context = {
      ...seed.context,
      targetType: seed.targetType,
      targetId: seed.targetId,
      reason: seed.reason,
    } as Prisma.InputJsonObject;

    if (existing) {
      return prisma.discoverySeed.update({
        where: {
          id: existing.id,
        },
        data: {
          priority: Math.max(existing.priority, seed.priority),
          context,
        },
      });
    }

    return prisma.discoverySeed.create({
      data: {
        scope: seed.scope,
        dedupeKey: seed.dedupeKey,
        priority: seed.priority,
        userId: seed.scope === "user" ? seed.userId ?? null : null,
        reason: getSeedReason(seed.reason),
        context,
        canonicalTrackId: seed.targetType === "track" ? seed.targetId : null,
        artistId: seed.targetType === "artist" ? seed.targetId : null,
      },
    });
  }

  private async enqueueJobsForSeed(
    prisma: PrismaClient,
    seedId: string,
    seedDedupeKey: string,
    seed: IndexGrowthSeedSpec,
  ) {
    let queuedJobs = 0;

    for (const jobType of seed.jobTypes) {
      const dedupeKey = `${seedDedupeKey}:${jobType}`;
      const existing = await prisma.discoveryJob.findUnique({
        where: {
          dedupeKey,
        },
      });

      if (existing && (existing.status === "PENDING" || existing.status === "RUNNING")) {
        continue;
      }

      if (existing) {
        await prisma.discoveryJob.update({
          where: {
            id: existing.id,
          },
          data: {
            status: "PENDING",
            priority: Math.max(existing.priority, seed.priority),
            runAfter: new Date(),
            error: null,
          },
        });
        queuedJobs += 1;
        continue;
      }

      await enqueueDiscoveryJob(prisma, {
        seedId,
        jobType,
        priority: seed.priority,
        dedupeKey,
        rateLimitKey: `${seed.scope}:${seed.targetType}:${seed.targetId}`,
        payload: {
          targetType: seed.targetType,
          targetId: seed.targetId,
          reason: seed.reason,
          scope: seed.scope,
          userId: seed.userId ?? null,
          context: seed.context as Prisma.InputJsonObject,
        },
      });
      queuedJobs += 1;
    }

    return queuedJobs;
  }
}

function emptyHealth(): CandidatePoolHealth {
  return {
    relevantPlayableTracks: 0,
    distinctArtists: 0,
    distinctClusters: 0,
    freshReleases: 0,
    sameArtistShare: 1,
    pendingJobs: 0,
    staleMetadataShare: 1,
    stalePlayableSourceShare: 1,
    suppressedByCooldown: {
      artistIds: [],
      tagIds: [],
      clusterIds: [],
    },
  };
}

export const indexGrowthController = new IndexGrowthController();
