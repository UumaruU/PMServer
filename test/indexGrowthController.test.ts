import { describe, expect, it } from "vitest";

import {
  buildIndexGrowthPlan,
  createDiscoveryDedupeKey,
  IndexGrowthController,
  resolvePoolLevel,
  type CandidatePoolHealth,
  type IndexGrowthThresholds,
} from "../src/discovery/indexGrowthController";

const thresholds: IndexGrowthThresholds = {
  emergencyPool: {
    minRelevantPlayableTracks: 4,
    minDistinctArtists: 2,
    minDistinctClusters: 2,
    minFreshReleases: 0,
    maxSameArtistShare: 0.85,
    maxPendingJobs: 50,
    maxStaleMetadataShare: 1,
  },
  minimumViablePool: {
    minRelevantPlayableTracks: 12,
    minDistinctArtists: 4,
    minDistinctClusters: 3,
    minFreshReleases: 1,
    maxSameArtistShare: 0.7,
    maxPendingJobs: 40,
    maxStaleMetadataShare: 0.8,
  },
  healthyPool: {
    minRelevantPlayableTracks: 30,
    minDistinctArtists: 12,
    minDistinctClusters: 6,
    minFreshReleases: 3,
    maxSameArtistShare: 0.45,
    maxPendingJobs: 30,
    maxStaleMetadataShare: 0.45,
  },
  richPool: {
    minRelevantPlayableTracks: 80,
    minDistinctArtists: 30,
    minDistinctClusters: 12,
    minFreshReleases: 8,
    maxSameArtistShare: 0.25,
    maxPendingJobs: 12,
    maxStaleMetadataShare: 0.2,
  },
};

function health(input: Partial<CandidatePoolHealth>): CandidatePoolHealth {
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
    ...input,
  };
}

describe("index growth pool health", () => {
  it("splits candidate health into configurable pool levels", () => {
    expect(resolvePoolLevel(health({ relevantPlayableTracks: 3, distinctArtists: 2 }), thresholds)).toBe("emergencyPool");
    expect(
      resolvePoolLevel(
        health({
          relevantPlayableTracks: 10,
          distinctArtists: 3,
          distinctClusters: 3,
          sameArtistShare: 0.6,
          staleMetadataShare: 0.5,
        }),
        thresholds,
      ),
    ).toBe("minimumViablePool");
    expect(
      resolvePoolLevel(
        health({
          relevantPlayableTracks: 32,
          distinctArtists: 14,
          distinctClusters: 7,
          freshReleases: 4,
          sameArtistShare: 0.35,
          pendingJobs: 5,
          staleMetadataShare: 0.25,
        }),
        thresholds,
      ),
    ).toBe("healthyPool");
    expect(
      resolvePoolLevel(
        health({
          relevantPlayableTracks: 100,
          distinctArtists: 40,
          distinctClusters: 18,
          freshReleases: 12,
          sameArtistShare: 0.12,
          pendingJobs: 2,
          staleMetadataShare: 0.08,
        }),
        thresholds,
      ),
    ).toBe("richPool");
  });

  it("builds urgent live and background growth plans for an emergency pool", () => {
    const plan = buildIndexGrowthPlan({
      userId: "user:1",
      poolLevel: "emergencyPool",
      health: health({
        relevantPlayableTracks: 2,
        distinctArtists: 1,
        distinctClusters: 1,
        suppressedByCooldown: {
          artistIds: ["artist:cooldown"],
          tagIds: ["tag:cooldown"],
          clusterIds: ["tag:cooldown"],
        },
      }),
      context: {
        currentCanonicalTrackId: "track:current",
        favoritedTrackIds: ["track:liked"],
        recentTrackIds: ["track:completed"],
        userFeatures: {
          topArtists: [
            { id: "artist:liked", score: 20 },
            { id: "artist:cooldown", score: 18 },
          ],
          topTags: [
            { id: "tag:synth", score: 12 },
            { id: "tag:cooldown", score: 11 },
          ],
        },
      },
    });

    expect(plan.shouldRunLiveExpansion).toBe(true);
    expect(plan.priority).toBeGreaterThan(80);
    expect(plan.userSeeds.map((seed) => seed.reason)).toEqual(
      expect.arrayContaining([
        "liked_artist",
        "liked_track",
        "completed_listen",
        "user_top_tag",
        "similar_artist",
        "adjacent_genre",
        "trending_artist_by_genre",
        "new_release",
        "collaborator_feature",
      ]),
    );
    expect(plan.userSeeds.find((seed) => seed.targetId === "artist:cooldown")?.priority).toBeLessThan(
      plan.userSeeds.find((seed) => seed.targetId === "artist:liked")!.priority,
    );
    expect(plan.userSeeds.find((seed) => seed.targetId === "tag:cooldown")?.priority).toBeLessThan(
      plan.userSeeds.find((seed) => seed.targetId === "tag:synth")!.priority,
    );
  });

  it("uses stable dedupe keys for idempotent discovery queueing", () => {
    expect(
      createDiscoveryDedupeKey({
        scope: "user",
        userId: "user:1",
        reason: "liked_artist",
        targetType: "artist",
        targetId: "artist:a",
      }),
    ).toBe(
      createDiscoveryDedupeKey({
        scope: "user",
        userId: "user:1",
        reason: "liked_artist",
        targetType: "artist",
        targetId: "artist:a",
      }),
    );
    expect(
      createDiscoveryDedupeKey({
        scope: "global",
        reason: "trending_artist",
        targetType: "scene",
        targetId: "global",
      }),
    ).not.toBe(
      createDiscoveryDedupeKey({
        scope: "user",
        userId: "user:1",
        reason: "trending_artist",
        targetType: "scene",
        targetId: "global",
      }),
    );
  });

  it("does not attach missing artist or track targets as foreign keys", async () => {
    const createdSeeds: Array<Record<string, unknown>> = [];
    const prisma = {
      discoverySeed: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdSeeds.push(data);
          return { id: "seed:1", ...data };
        },
      },
      discoveryJob: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "job:1", ...data }),
      },
      artist: {
        findUnique: async () => null,
      },
      canonicalTrack: {
        findUnique: async () => null,
      },
    };
    const controller = new IndexGrowthController();

    await controller.enqueueGlobalBootstrap(prisma as never, { tags: ["missing-genre"] });

    expect(createdSeeds.length).toBeGreaterThan(0);
    expect(createdSeeds.every((seed) => seed.artistId === null && seed.canonicalTrackId === null)).toBe(true);
  });
});
