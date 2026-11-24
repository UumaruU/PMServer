import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import type { AppConfig } from "../src/config";

const adminToken = "test-admin-token";
const requestId = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";

function buildConfig(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgresql://postgres:postgres@localhost:5432/pingu_music_test",
    jwtAccessSecret: "test-access-secret",
    jwtRefreshSecret: "test-refresh-secret",
    jwtAccessExpiresIn: "15m",
    jwtRefreshExpiresIn: "30d",
    rateLimitMax: 50,
    rateLimitWindow: "1 minute",
    lastfmApiKey: null,
    deezerApiBaseUrl: "https://api.deezer.com",
    listenBrainzApiBaseUrl: "https://api.listenbrainz.org/1",
    discoveryWorkerEnabled: false,
    discoveryLiveExpansionEnabled: true,
    discoveryMaxLiveProviderCalls: 3,
    discoveryMaxJobsPerTick: 3,
    discoveryBackfillOnStartup: false,
    discoveryBackfillBatchSize: 200,
    adminApiToken: adminToken,
  };
}

function buildPrismaStub() {
  const recommendationRequest = {
    id: requestId,
    userId,
    surface: "stream",
    mode: "autoplay",
    strategy: "user-feed",
    contextSummary: "taste profile",
    seed: { mode: "autoplay" },
    input: { limit: 1 },
    userProfileSnapshot: { topEntityAffinities: { artists: [{ id: "artist:seed", value: 4 }] } },
    userFeatureSnapshot: { topArtists: [{ id: "artist:seed", score: 18 }] },
    contextSnapshot: { recentTrackIds: ["track:recent"] },
    poolHealthSnapshot: { relevantPlayableTracks: 2 },
    candidateGeneratorSummary: { generatedCandidateCountBySource: { relatedArtists: 1 } },
    expansionSummary: { expanded: true, queuedJobs: 2 },
    finalRecommendations: [{ canonicalTrackId: "track:candidate" }],
    sampled: true,
    sampleRate: 1,
    compact: true,
    status: "completed",
    error: null,
    createdAt: new Date("2026-05-24T12:00:00.000Z"),
    completedAt: new Date("2026-05-24T12:00:01.000Z"),
    expiresAt: new Date("2026-06-07T12:00:00.000Z"),
  };
  const candidateSnapshots = [
    {
      id: "candidate-generated",
      recommendationRequestId: requestId,
      canonicalTrackId: "track:candidate",
      preferredVariantId: "variant:track:candidate",
      stage: "generated",
      rank: null,
      score: 1.2,
      sourceChannels: ["relatedArtists"],
      sourceSummary: { channelWeights: { relatedArtists: 1.2 } },
      reasonSummary: { mergedEvidence: [{ seedArtistId: "artist:seed", relatedArtistId: "artist:neighbor" }] },
      trackSnapshot: { title: "Candidate" },
      isFinal: false,
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    },
    {
      id: "candidate-final",
      recommendationRequestId: requestId,
      canonicalTrackId: "track:candidate",
      preferredVariantId: "variant:track:candidate",
      stage: "final",
      rank: 1,
      score: 6.7,
      sourceChannels: ["relatedArtists"],
      sourceSummary: {},
      reasonSummary: {},
      trackSnapshot: { title: "Candidate" },
      isFinal: true,
      createdAt: new Date("2026-05-24T12:00:01.000Z"),
    },
  ];
  const scoreBreakdowns = [
    {
      id: "score-1",
      recommendationRequestId: requestId,
      canonicalTrackId: "track:candidate",
      rank: 1,
      finalScore: 6.7,
      components: {
        userTasteSimilarity: 0.7,
        graphSimilarity: 0.8,
        tagMatch: 0.5,
        playlistCooccurrence: 0.25,
        novelty: 1,
        freshness: 0.2,
        sourceQuality: 0.9,
      },
      penalties: {
        cooldownPenalty: 0.2,
        exposureFatigue: 0.1,
        diversityPenalty: 0.6,
      },
      createdAt: new Date("2026-05-24T12:00:01.000Z"),
    },
  ];
  const filterLogs = [
    {
      id: "filter-1",
      recommendationRequestId: requestId,
      canonicalTrackId: "track:recent",
      stage: "hard_filter",
      reason: "recently_played",
      score: 1.1,
      details: { sourceChannels: ["userTopTracks"] },
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    },
  ];
  const graphEdges = [
    {
      id: "edge-1",
      recommendationRequestId: requestId,
      candidateTrackId: "track:candidate",
      sourceNodeType: "Artist",
      sourceNodeId: "artist:seed",
      targetNodeType: "Artist",
      targetNodeId: "artist:neighbor",
      edgeType: "similar_artist",
      weight: 0.8,
      confidence: null,
      reason: "candidate_generation",
      evidence: {},
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    },
  ];
  const poolHealthSnapshots = [
    {
      id: "pool-1",
      recommendationRequestId: requestId,
      userId,
      poolLevel: "emergencyPool",
      health: { relevantPlayableTracks: 2, distinctArtists: 1 },
      plan: { shouldRunLiveExpansion: true },
      queuedJobs: 2,
      liveExpansion: { providerCalls: 1, ingestedTrackIds: ["track:new"] },
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    },
  ];
  const discoveryJob = {
    id: "11111111-1111-4111-8111-111111111111",
    seedId: "22222222-2222-4222-8222-222222222222",
    jobType: "find_similar_artists",
    status: "PENDING",
    priority: 100,
    providerId: "lastfm",
    payload: { artistId: "artist:seed" },
    result: null,
    error: null,
    createdAt: new Date("2026-05-24T12:00:00.000Z"),
    updatedAt: new Date("2026-05-24T12:00:00.000Z"),
    seed: { id: "22222222-2222-4222-8222-222222222222", reason: "similar_artist" },
  };
  const artist = {
    id: "artist:seed",
    name: "Seed Artist",
    tags: ["synth"],
    sources: [{ providerId: "lastfm", sourceArtistId: "seed" }],
    tracks: [{ id: "track:candidate", title: "Candidate" }],
  };
  const track = {
    id: "track:candidate",
    title: "Candidate",
    artistName: "Seed Artist",
    tags: ["synth"],
    artists: [artist],
    sources: [{ providerId: "hitmos", sourceTrackId: "candidate", isPlayable: true }],
  };
  const artistSimilarities = [
    {
      id: "similarity-1",
      sourceArtistId: "artist:seed",
      targetArtistId: "artist:neighbor",
      providerId: "lastfm",
      score: 0.8,
      confidence: 0.7,
      reason: "similar",
      sourceArtist: artist,
      targetArtist: { id: "artist:neighbor", name: "Neighbor Artist", tags: ["synth"] },
    },
  ];
  const trackEdges = [
    {
      id: "track-edge-1",
      sourceTrackId: "track:candidate",
      targetTrackId: "track:neighbor",
      artistId: "artist:seed",
      edgeType: "related_artist_track",
      providerId: "lastfm",
      weight: 0.8,
      confidence: 0.7,
      reason: "live_expansion",
      sourceTrack: track,
      targetTrack: { id: "track:neighbor", title: "Neighbor Track", tags: ["synth"] },
      artist,
    },
  ];

  return {
    $disconnect: async () => undefined,
    recommendationRequest: {
      count: async () => 1,
      findMany: async () => [recommendationRequest],
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === requestId ? recommendationRequest : null),
    },
    recommendationCandidateSnapshot: {
      findMany: async () => candidateSnapshots,
    },
    recommendationScoreBreakdown: {
      findMany: async () => scoreBreakdowns,
    },
    recommendationFilterLog: {
      findMany: async () => filterLogs,
    },
    recommendationFeatureSnapshot: {
      findMany: async () => [],
    },
    recommendationReasonSnapshot: {
      findMany: async () => [],
    },
    poolHealthSnapshot: {
      findMany: async () => poolHealthSnapshots,
    },
    discoveryJobLog: {
      findMany: async () => [],
    },
    providerResultLog: {
      findMany: async () => [],
    },
    graphEdgeAudit: {
      findMany: async () => graphEdges,
    },
    userRecommendationProfile: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        where.userId === userId
          ? {
              userId,
              bootstrapProfile: {},
              shortTermProfile: {},
              longTermProfile: {},
              sessionProfile: {},
              entityProfile: {},
              profileRevision: 3,
              createdAt: new Date("2026-05-24T12:00:00.000Z"),
              updatedAt: new Date("2026-05-24T12:00:00.000Z"),
            }
          : null,
    },
    discoveryJob: {
      count: async () => 1,
      findMany: async () => [discoveryJob],
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === discoveryJob.id ? discoveryJob : null),
    },
    artist: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === artist.id ? artist : null),
    },
    artistSimilarity: {
      findMany: async () => artistSimilarities,
    },
    canonicalTrack: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === track.id ? track : null),
    },
    trackEdge: {
      findMany: async () => trackEdges,
    },
  };
}

describe("admin recommendation observatory routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      config: buildConfig(),
      prisma: buildPrismaStub() as never,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const adminGet = (url: string, token = adminToken) =>
    app.inject({
      method: "GET",
      url,
      headers: {
        "x-admin-token": token,
      },
    });

  it("blocks admin endpoints without the internal admin token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/recommendations/requests",
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns recommendation request trace JSON endpoints", async () => {
    const list = await adminGet("/admin/recommendations/requests");
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [{ id: requestId, userId, surface: "stream" }],
      pagination: { total: 1 },
    });

    const detail = await adminGet(`/admin/recommendations/requests/${requestId}`);
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.request).toMatchObject({ id: requestId });
    expect(detailBody.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ canonicalTrackId: "track:candidate" })]),
    );
    expect(detailBody.scoreBreakdowns).toEqual(
      expect.arrayContaining([expect.objectContaining({ canonicalTrackId: "track:candidate", finalScore: 6.7 })]),
    );
    expect(detailBody.filterLogs).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "recently_played" })]));
    expect(detailBody.graphEdges).toEqual(expect.arrayContaining([expect.objectContaining({ edgeType: "similar_artist" })]));

    const funnel = await adminGet(`/admin/recommendations/requests/${requestId}/funnel`);
    expect(funnel.statusCode).toBe(200);
    expect(funnel.json()).toMatchObject({
      requestId,
      generatedCandidateCountBySource: { relatedArtists: 1 },
      filteredCandidateCountByReason: { recently_played: 1 },
      generatedCandidateCount: 1,
      remainingCandidateCount: 1,
      finalReturnedTrackCount: 1,
    });

    const candidates = await adminGet(`/admin/recommendations/requests/${requestId}/candidates`);
    expect(candidates.statusCode).toBe(200);
    const candidatesBody = candidates.json();
    expect(candidatesBody.requestId).toBe(requestId);
    expect(candidatesBody.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ canonicalTrackId: "track:candidate" })]),
    );
    expect(candidatesBody.scoreBreakdowns).toEqual(expect.arrayContaining([expect.objectContaining({ finalScore: 6.7 })]));

    const filtered = await adminGet(`/admin/recommendations/requests/${requestId}/filtered`);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({
      requestId,
      items: [{ canonicalTrackId: "track:recent", reason: "recently_played" }],
    });

    const graph = await adminGet(`/admin/recommendations/requests/${requestId}/graph`);
    expect(graph.statusCode).toBe(200);
    expect(graph.json()).toMatchObject({
      requestId,
      edges: [{ type: "similar_artist", source: "Artist:artist:seed", target: "Artist:artist:neighbor" }],
    });
  });

  it("returns user, discovery, graph, and vector debug JSON endpoints", async () => {
    expect((await adminGet(`/admin/users/${userId}/recommendation-profile`)).json()).toMatchObject({
      userId,
      profile: { profileRevision: 3 },
    });
    expect((await adminGet(`/admin/users/${userId}/pool-health`)).json()).toMatchObject({
      userId,
      latest: { poolLevel: "emergencyPool" },
    });
    expect((await adminGet("/admin/discovery/jobs")).json()).toMatchObject({
      items: [{ id: "11111111-1111-4111-8111-111111111111", jobType: "find_similar_artists" }],
    });
    expect((await adminGet("/admin/discovery/jobs/11111111-1111-4111-8111-111111111111")).json()).toMatchObject({
      job: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect((await adminGet("/admin/graph/artists/artist:seed")).json()).toMatchObject({
      artist: { id: "artist:seed" },
      similarArtists: [{ targetArtistId: "artist:neighbor" }],
    });
    expect((await adminGet("/admin/graph/tracks/track:candidate")).json()).toMatchObject({
      track: { id: "track:candidate" },
      edges: [{ targetTrackId: "track:neighbor" }],
    });
    expect((await adminGet("/admin/vector/tracks/track:candidate/neighbors")).json()).toMatchObject({
      entityType: "track",
      entityId: "track:candidate",
      vectorAvailable: false,
      neighbors: [{ id: "track:neighbor" }],
    });
    expect((await adminGet("/admin/vector/artists/artist:seed/neighbors")).json()).toMatchObject({
      entityType: "artist",
      entityId: "artist:seed",
      vectorAvailable: false,
      neighbors: [{ id: "artist:neighbor" }],
    });
  });
});
