import { describe, expect, it } from "vitest";

import { createEmptyProfiles } from "../src/recommendation/affinity/profileStore";
import {
  buildRecommendationAuditRows,
  persistRecommendationAudit,
} from "../src/recommendation/audit/recommendationAudit";
import { explainScoredCandidateFilter } from "../src/recommendation/filtering/filterCandidates";
import type { RecommendationCatalogSnapshot, RecommendationContext } from "../src/recommendation/types";

const requestId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

function track(id: string, input: { playable?: boolean; confidence?: number } = {}) {
  const playable = input.playable ?? true;

  return {
    canonicalTrackId: id,
    title: id,
    preferredVariantId: playable ? `variant:${id}` : null,
    playableVariantIds: playable ? [`variant:${id}`] : [],
    primaryCanonicalArtistId: `artist:${id}`,
    tagIds: ["tag:synth"],
    tagWeights: {
      "tag:synth": 1,
    },
    quality: {
      clusterConfidence: input.confidence ?? 0.9,
      trustScore: 0.8,
      metadataCompleteness: 0.8,
      popularityPrior: 0.2,
    },
  } as unknown as RecommendationCatalogSnapshot["tracksById"][string];
}

describe("recommendation audit tracing", () => {
  it("explains hard filter reasons without changing filter behavior", () => {
    const profiles = createEmptyProfiles();
    const context = {
      currentCanonicalTrackId: "track:current",
      favoritedTrackIds: ["track:favorite"],
      recentTrackIds: ["track:recent"],
      userFeatures: {
        negative: {
          hardSuppressedTrackIds: ["track:suppressed"],
          temporarilyHiddenTrackIds: ["track:hidden"],
          fatiguePenaltyByTrackId: {},
        },
      },
    } as unknown as RecommendationContext;
    const snapshot = {
      tracksById: {
        "track:favorite": track("track:favorite"),
        "track:recent": track("track:recent"),
        "track:unplayable": track("track:unplayable", { playable: false }),
        "track:low-quality": track("track:low-quality", { confidence: 0.1 }),
        "track:suppressed": track("track:suppressed"),
        "track:hidden": track("track:hidden"),
        "track:non-positive": track("track:non-positive"),
      },
    } as unknown as RecommendationCatalogSnapshot;

    const base = {
      snapshot,
      context,
      profiles,
      minCanonicalConfidence: 0.4,
    };

    expect(
      explainScoredCandidateFilter({
        ...base,
        candidate: {
          canonicalTrackId: "track:favorite",
          scoreBreakdown: { finalScore: 1 },
          __track: snapshot.tracksById["track:favorite"],
        },
      })?.reason,
    ).toBe("favorite");
    expect(
      explainScoredCandidateFilter({
        ...base,
        candidate: {
          canonicalTrackId: "track:recent",
          scoreBreakdown: { finalScore: 1 },
          __track: snapshot.tracksById["track:recent"],
        },
      })?.reason,
    ).toBe("recently_played");
    expect(
      explainScoredCandidateFilter({
        ...base,
        candidate: {
          canonicalTrackId: "track:unplayable",
          scoreBreakdown: { finalScore: 1 },
          __track: snapshot.tracksById["track:unplayable"],
        },
      })?.reason,
    ).toBe("no_playable_source");
    expect(
      explainScoredCandidateFilter({
        ...base,
        candidate: {
          canonicalTrackId: "track:low-quality",
          scoreBreakdown: { finalScore: 1 },
          __track: snapshot.tracksById["track:low-quality"],
        },
      })?.reason,
    ).toBe("low_quality");
    expect(
      explainScoredCandidateFilter({
        ...base,
        candidate: {
          canonicalTrackId: "track:suppressed",
          scoreBreakdown: { finalScore: 1 },
          __track: snapshot.tracksById["track:suppressed"],
        },
      })?.reason,
    ).toBe("hard_suppressed");
    expect(
      explainScoredCandidateFilter({
        ...base,
        candidate: {
          canonicalTrackId: "track:hidden",
          scoreBreakdown: { finalScore: 1 },
          __track: snapshot.tracksById["track:hidden"],
        },
      })?.reason,
    ).toBe("temporarily_hidden");
    expect(
      explainScoredCandidateFilter({
        ...base,
        candidate: {
          canonicalTrackId: "track:non-positive",
          scoreBreakdown: { finalScore: 0 },
          __track: snapshot.tracksById["track:non-positive"],
        },
      })?.reason,
    ).toBe("non_positive_score");
  });

  it("builds compact audit rows linked to one recommendation request", () => {
    const profiles = createEmptyProfiles();
    profiles.entity.artistAffinities["artist:seed"] = {
      value: 4,
      eventCount: 2,
      updatedAt: "2026-05-24T00:00:00.000Z",
    };
    const scoredCandidate = {
      canonicalTrackId: "track:candidate",
      preferredVariantId: "variant:track:candidate",
      sourceChannels: ["relatedArtists"],
      channelWeights: { relatedArtists: 1.2 },
      mergedEvidence: [{ seedArtistId: "artist:seed", relatedArtistId: "artist:neighbor", relationWeight: 0.8 }],
      baseScore: 3.4,
      scoreBreakdown: {
        sameArtistScore: 0,
        collaboratorScore: 0,
        relatedArtistScore: 0.8,
        tagOverlapScore: 0.5,
        sessionFitScore: 0.4,
        releaseProximityScore: 0,
        tasteAffinityScore: 0.7,
        durationFitScore: 0.2,
        flavorFitScore: 0.1,
        qualityScore: 0.9,
        availabilityScore: 1,
        popularityPriorScore: 0.2,
        noveltyScore: 1,
        userAffinityScore: 0.7,
        recentIntentScore: 0.3,
        cooccurrenceScore: 0.25,
        contextScore: 0.45,
        explorationScore: 0.6,
        finalScore: 6.7,
      },
      penaltiesApplied: {
        repetitionPenalty: 0.2,
        duplicatePenalty: 0,
        skipPenalty: 0,
        explicitMismatchPenalty: 0.1,
        totalPenalty: 0.6,
      },
      __track: track("track:candidate"),
    };
    const rows = buildRecommendationAuditRows({
      requestId,
      userId,
      surface: "stream",
      mode: "autoplay",
      seed: { mode: "autoplay" },
      input: { limit: 1 },
      strategy: "user-feed",
      contextSummary: "taste profile",
      context: {
        mode: "autoplay",
        recentTrackIds: ["track:recent"],
        recentArtistIds: ["artist:recent"],
        recentTagCloud: { "tag:synth": 2 },
        recentRecommendationIds: [],
        skippedTrackIds: [],
        favoritedTrackIds: ["track:fav"],
        currentFeaturedArtistIds: [],
        currentTrackTagIds: [],
        currentArtistTagIds: [],
      } as RecommendationContext,
      profiles,
      discoveryResult: {
        expanded: true,
        existingCount: 2,
        poolLevel: "emergencyPool",
        health: {
          relevantPlayableTracks: 2,
          distinctArtists: 1,
          distinctClusters: 1,
          freshReleases: 0,
          sameArtistShare: 1,
          pendingJobs: 3,
          staleMetadataShare: 0.5,
          stalePlayableSourceShare: 0.4,
          suppressedByCooldown: {
            artistIds: ["artist:recent"],
            tagIds: ["tag:synth"],
            clusterIds: ["cluster:1"],
          },
        },
        queuedJobs: 4,
        ingestedTrackIds: ["track:new"],
        liveExpansion: {
          ingestedTrackIds: ["track:new"],
          providerCalls: 2,
        },
        plan: {
          poolLevel: "emergencyPool",
          shouldRunLiveExpansion: true,
          shouldQueueBackgroundExpansion: true,
          priority: 100,
          userSeeds: [],
        },
      },
      trace: {
        generatedCandidates: [
          {
            canonicalTrackId: "track:candidate",
            sourceChannels: ["relatedArtists"],
            channelWeights: { relatedArtists: 1.2 },
            mergedEvidence: scoredCandidate.mergedEvidence,
            baseScore: 1.2,
          },
        ],
        scoredCandidates: [scoredCandidate],
        filterLogs: [
          {
            canonicalTrackId: "track:filtered",
            stage: "hard_filter",
            reason: "recently_played",
            details: { sourceChannels: ["userTopTracks"] },
            score: 1.1,
          },
        ],
        rankedCandidates: [scoredCandidate],
        recommendations: [
          {
            canonicalTrackId: "track:candidate",
            preferredVariantId: "variant:track:candidate",
            sourceChannels: ["relatedArtists"],
            score: 6.7,
            explanation: {
              canonicalTrackId: "track:candidate",
              preferredVariantId: "variant:track:candidate",
              sourceChannels: ["relatedArtists"],
              scoreBreakdown: scoredCandidate.scoreBreakdown,
              topReasons: ["channel:relatedArtists"],
              penaltiesApplied: scoredCandidate.penaltiesApplied,
              suppressedCompetitors: [],
              relevantTags: ["Synth"],
              relevantArtists: ["Neighbor"],
            },
          },
        ],
      },
      finalRecommendations: [
        {
          canonicalTrackId: "track:candidate",
          track: { id: "variant:track:candidate", title: "Candidate" },
        },
      ],
      config: {
        enabled: true,
        sampleRate: 1,
        compact: true,
        retentionDays: 14,
        rawProviderPayloadsEnabled: false,
        rawProviderPayloadTtlDays: 2,
        rawProviderPayloadMaxBytes: 16_384,
      },
      now: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(rows.request.data).toMatchObject({
      id: requestId,
      userId,
      surface: "stream",
      mode: "autoplay",
      strategy: "user-feed",
      sampled: true,
    });
    expect(rows.candidateSnapshots.data.map((row) => row.recommendationRequestId)).toEqual([requestId, requestId]);
    expect(rows.candidateSnapshots.data.map((row) => row.stage)).toEqual(["generated", "final"]);
    expect(rows.scoreBreakdowns.data[0]).toMatchObject({
      recommendationRequestId: requestId,
      canonicalTrackId: "track:candidate",
      finalScore: 6.7,
    });
    expect(rows.filterLogs.data[0]).toMatchObject({
      recommendationRequestId: requestId,
      canonicalTrackId: "track:filtered",
      reason: "recently_played",
    });
    expect(rows.poolHealthSnapshots.data[0]).toMatchObject({
      recommendationRequestId: requestId,
      userId,
      poolLevel: "emergencyPool",
      queuedJobs: 4,
    });
    expect(rows.discoveryJobLogs.data[0]).toMatchObject({
      recommendationRequestId: requestId,
      action: "ensure_candidate_pool",
      status: "expanded",
      providerCallCount: 2,
    });
    expect(rows.featureSnapshots.data.some((row) => row.recommendationRequestId === requestId)).toBe(true);
    expect(rows.reasonSnapshots.data[0]).toMatchObject({
      recommendationRequestId: requestId,
      canonicalTrackId: "track:candidate",
    });
    expect(rows.graphEdgeAudits.data[0]).toMatchObject({
      recommendationRequestId: requestId,
      edgeType: "similar_artist",
      sourceNodeId: "artist:seed",
      targetNodeId: "artist:neighbor",
      candidateTrackId: "track:candidate",
    });
  });

  it("keeps recommendation responses passive when audit persistence fails", async () => {
    const result = await persistRecommendationAudit(
      {
        recommendationRequest: {
          create: async () => {
            throw new Error("audit db unavailable");
          },
        },
      } as never,
      {
        request: {
          data: {
            id: requestId,
          },
        },
        candidateSnapshots: { data: [] },
        featureSnapshots: { data: [] },
        reasonSnapshots: { data: [] },
        filterLogs: { data: [] },
        scoreBreakdowns: { data: [] },
        poolHealthSnapshots: { data: [] },
        discoveryJobLogs: { data: [] },
        providerResultLogs: { data: [] },
        graphEdgeAudits: { data: [] },
      },
    );

    expect(result.persisted).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });
});
