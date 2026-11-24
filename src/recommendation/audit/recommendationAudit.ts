import type { PrismaClient } from "@prisma/client";

import type { CandidatePoolHealth, IndexGrowthPlan, LiveExpansionResult } from "../../discovery/indexGrowthController";
import type {
  PenaltyBreakdown,
  RecommendationContext,
  RecommendationProfiles,
  RecommendationSeed,
  ScoreBreakdown,
} from "../types";

type JsonRecord = Record<string, unknown>;

export interface RecommendationAuditConfig {
  enabled: boolean;
  sampleRate: number;
  compact: boolean;
  retentionDays: number;
  rawProviderPayloadsEnabled: boolean;
  rawProviderPayloadTtlDays: number;
  rawProviderPayloadMaxBytes: number;
}

export interface RecommendationAuditCandidate {
  canonicalTrackId: string;
  preferredVariantId?: string | null;
  sourceChannels: string[];
  channelWeights?: Record<string, number>;
  mergedEvidence?: JsonRecord[];
  baseScore?: number;
  scoreBreakdown?: ScoreBreakdown;
  penaltiesApplied?: PenaltyBreakdown;
  __track?: {
    canonicalTrackId?: string;
    title?: string;
    artistName?: string;
    primaryCanonicalArtistId?: string | null;
    canonicalArtistIds?: string[];
    canonicalReleaseId?: string | null;
    tagIds?: string[];
    preferredVariantId?: string | null;
    playableVariantIds?: string[];
    quality?: JsonRecord;
  };
}

export interface RecommendationAuditFilterLog {
  canonicalTrackId: string;
  stage: string;
  reason: string;
  score?: number;
  details?: JsonRecord;
}

export interface RecommendationAuditTrace {
  generatedCandidates: RecommendationAuditCandidate[];
  scoredCandidates: RecommendationAuditCandidate[];
  filterLogs: RecommendationAuditFilterLog[];
  rankedCandidates: RecommendationAuditCandidate[];
  recommendations: Array<{
    canonicalTrackId: string;
    preferredVariantId: string;
    sourceChannels: string[];
    score: number;
    explanation?: unknown;
  }>;
}

export interface RecommendationAuditDiscoveryResult {
  expanded: boolean;
  existingCount: number;
  poolLevel: string;
  health: CandidatePoolHealth;
  queuedJobs: number;
  ingestedTrackIds: string[];
  liveExpansion?: LiveExpansionResult | null;
  plan?: IndexGrowthPlan | null;
}

export interface BuildRecommendationAuditRowsInput {
  requestId: string;
  userId: string;
  surface: string;
  mode?: string | null;
  seed: RecommendationSeed;
  input?: unknown;
  strategy?: string | null;
  contextSummary?: string | null;
  context: RecommendationContext;
  profiles: RecommendationProfiles;
  discoveryResult?: RecommendationAuditDiscoveryResult | null;
  trace?: RecommendationAuditTrace | null;
  finalRecommendations: unknown[];
  config: RecommendationAuditConfig;
  now?: Date;
}

type CreateManyRows<T extends JsonRecord> = {
  data: T[];
};

export interface RecommendationAuditRows {
  request: {
    data: JsonRecord;
  };
  candidateSnapshots: CreateManyRows<JsonRecord>;
  featureSnapshots: CreateManyRows<JsonRecord>;
  reasonSnapshots: CreateManyRows<JsonRecord>;
  filterLogs: CreateManyRows<JsonRecord>;
  scoreBreakdowns: CreateManyRows<JsonRecord>;
  poolHealthSnapshots: CreateManyRows<JsonRecord>;
  discoveryJobLogs: CreateManyRows<JsonRecord>;
  providerResultLogs: CreateManyRows<JsonRecord>;
  graphEdgeAudits: CreateManyRows<JsonRecord>;
}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function loadRecommendationAuditConfig(): RecommendationAuditConfig {
  return {
    enabled: readBooleanEnv("RECOMMENDATION_DEBUG_AUDIT_ENABLED", true),
    sampleRate: clamp(readNumberEnv("RECOMMENDATION_DEBUG_AUDIT_SAMPLE_RATE", 1), 0, 1),
    compact: readBooleanEnv("RECOMMENDATION_DEBUG_AUDIT_COMPACT", true),
    retentionDays: Math.max(1, readNumberEnv("RECOMMENDATION_DEBUG_AUDIT_RETENTION_DAYS", 14)),
    rawProviderPayloadsEnabled: readBooleanEnv("RECOMMENDATION_DEBUG_AUDIT_RAW_PROVIDER_PAYLOADS", false),
    rawProviderPayloadTtlDays: Math.max(1, readNumberEnv("RECOMMENDATION_DEBUG_AUDIT_RAW_PROVIDER_PAYLOAD_TTL_DAYS", 2)),
    rawProviderPayloadMaxBytes: Math.max(1024, readNumberEnv("RECOMMENDATION_DEBUG_AUDIT_RAW_PROVIDER_PAYLOAD_MAX_BYTES", 16_384)),
  };
}

function deterministicRatio(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 0xffffffff;
}

export function shouldSampleRecommendationAudit(requestId: string, config: RecommendationAuditConfig) {
  if (!config.enabled || config.sampleRate <= 0) {
    return false;
  }

  if (config.sampleRate >= 1) {
    return true;
  }

  return deterministicRatio(requestId) <= config.sampleRate;
}

function normalizeJson(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }

  if (typeof value === "object") {
    return Object.entries(value as JsonRecord).reduce<JsonRecord>((accumulator, [key, entry]) => {
      if (entry !== undefined) {
        accumulator[key] = normalizeJson(entry);
      }
      return accumulator;
    }, {});
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  return String(value);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function compactEntries<T>(entries: T[], limit: number) {
  return entries.slice(0, limit);
}

function compactProfiles(profiles: RecommendationProfiles) {
  return {
    bootstrap: profiles.bootstrap,
    session: {
      recentRecommendationIds: compactEntries(profiles.session.recentRecommendationIds, 16),
      recentSkippedTrackIds: compactEntries(profiles.session.recentSkippedTrackIds, 16),
      recentFastSkippedTrackIds: compactEntries(profiles.session.recentFastSkippedTrackIds, 16),
      recentDislikedTrackIds: compactEntries(profiles.session.recentDislikedTrackIds, 16),
      recentDismissedTrackIds: compactEntries(profiles.session.recentDismissedTrackIds, 16),
      channelPenalties: profiles.session.channelPenalties,
    },
    entityCounts: {
      trackAffinities: Object.keys(profiles.entity.trackAffinities).length,
      artistAffinities: Object.keys(profiles.entity.artistAffinities).length,
      releaseAffinities: Object.keys(profiles.entity.releaseAffinities).length,
      tagAffinities: Object.keys(profiles.entity.tagAffinities).length,
      dislikedTrackIds: profiles.entity.dislikedTrackIds.length,
      dismissedTrackIds: profiles.entity.dismissedTrackIds.length,
    },
    topEntityAffinities: {
      artists: topScoreMap(profiles.entity.artistAffinities, 12),
      tags: topScoreMap(profiles.entity.tagAffinities, 12),
      tracks: topScoreMap(profiles.entity.trackAffinities, 12),
      releases: topScoreMap(profiles.entity.releaseAffinities, 12),
    },
  };
}

function topScoreMap(values: Record<string, { value: number; eventCount: number; updatedAt: string }>, limit: number) {
  return Object.entries(values)
    .map(([id, entry]) => ({
      id,
      value: entry.value,
      eventCount: entry.eventCount,
      updatedAt: entry.updatedAt,
    }))
    .sort((left, right) => {
      if (left.value !== right.value) {
        return right.value - left.value;
      }

      return left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}

function compactContext(context: RecommendationContext) {
  return {
    mode: context.mode,
    currentCanonicalTrackId: context.currentCanonicalTrackId ?? null,
    currentPrimaryArtistId: context.currentPrimaryArtistId ?? null,
    playbackPrimaryArtistId: context.playbackPrimaryArtistId ?? null,
    currentReleaseId: context.currentReleaseId ?? null,
    currentFlavor: context.currentFlavor ?? null,
    recentTrackIds: compactEntries(context.recentTrackIds, 24),
    recentArtistIds: compactEntries(context.recentArtistIds, 24),
    recentTagCloud: context.recentTagCloud,
    recentRecommendationIds: compactEntries(context.recentRecommendationIds, 24),
    skippedTrackIds: compactEntries(context.skippedTrackIds, 24),
    favoritedTrackIds: compactEntries(context.favoritedTrackIds, 24),
  };
}

function summarizeCandidateGenerators(candidates: RecommendationAuditCandidate[]) {
  const bySource = candidates.reduce<Record<string, number>>((accumulator, candidate) => {
    candidate.sourceChannels.forEach((channel) => {
      accumulator[channel] = (accumulator[channel] ?? 0) + 1;
    });
    return accumulator;
  }, {});

  return {
    generatedCandidateCount: candidates.length,
    sourcesUsed: Object.keys(bySource).sort(),
    generatedCandidateCountBySource: bySource,
  };
}

function compactTrackSnapshot(candidate: RecommendationAuditCandidate) {
  const track = candidate.__track;
  if (!track) {
    return null;
  }

  return {
    canonicalTrackId: track.canonicalTrackId ?? candidate.canonicalTrackId,
    title: track.title,
    artistName: track.artistName,
    primaryCanonicalArtistId: track.primaryCanonicalArtistId ?? null,
    canonicalArtistIds: compactEntries(track.canonicalArtistIds ?? [], 8),
    canonicalReleaseId: track.canonicalReleaseId ?? null,
    tagIds: compactEntries(track.tagIds ?? [], 12),
    preferredVariantId: track.preferredVariantId ?? candidate.preferredVariantId ?? null,
    playableVariantCount: track.playableVariantIds?.length ?? 0,
    quality: track.quality ?? null,
  };
}

function getCandidatePreferredVariantId(candidate: RecommendationAuditCandidate) {
  return candidate.preferredVariantId ?? candidate.__track?.preferredVariantId ?? null;
}

function buildCandidateSnapshotRow(params: {
  requestId: string;
  candidate: RecommendationAuditCandidate;
  stage: string;
  rank?: number | null;
  isFinal?: boolean;
}) {
  return {
    recommendationRequestId: params.requestId,
    canonicalTrackId: params.candidate.canonicalTrackId,
    preferredVariantId: getCandidatePreferredVariantId(params.candidate),
    stage: params.stage,
    rank: params.rank ?? null,
    score: params.candidate.scoreBreakdown?.finalScore ?? params.candidate.baseScore ?? null,
    sourceChannels: params.candidate.sourceChannels,
    sourceSummary: normalizeJson({
      channelWeights: params.candidate.channelWeights ?? {},
      baseScore: params.candidate.baseScore ?? null,
    }),
    reasonSummary: normalizeJson({
      mergedEvidence: params.candidate.mergedEvidence ?? [],
    }),
    trackSnapshot: normalizeJson(compactTrackSnapshot(params.candidate)),
    isFinal: params.isFinal ?? false,
  };
}

function normalizeScoreComponents(scoreBreakdown: ScoreBreakdown) {
  return {
    finalScore: scoreBreakdown.finalScore,
    userTasteSimilarity: scoreBreakdown.userAffinityScore,
    graphSimilarity: Math.max(
      scoreBreakdown.sameArtistScore,
      scoreBreakdown.collaboratorScore,
      scoreBreakdown.relatedArtistScore,
      scoreBreakdown.contextScore,
    ),
    tagMatch: Math.max(scoreBreakdown.tagOverlapScore, scoreBreakdown.sessionFitScore),
    playlistCooccurrence: scoreBreakdown.cooccurrenceScore,
    novelty: scoreBreakdown.noveltyScore,
    freshness: scoreBreakdown.popularityPriorScore,
    sourceQuality: scoreBreakdown.qualityScore,
    availability: scoreBreakdown.availabilityScore,
    raw: scoreBreakdown,
  };
}

function normalizePenaltyComponents(penalties?: PenaltyBreakdown) {
  if (!penalties) {
    return null;
  }

  return {
    cooldownPenalty: penalties.repetitionPenalty,
    exposureFatigue: penalties.explicitMismatchPenalty,
    diversityPenalty: penalties.totalPenalty,
    duplicatePenalty: penalties.duplicatePenalty,
    skipPenalty: penalties.skipPenalty,
    raw: penalties,
  };
}

function buildScoreBreakdownRows(requestId: string, candidates: RecommendationAuditCandidate[]) {
  const rows: JsonRecord[] = [];

  candidates.forEach((candidate, index) => {
    if (!candidate.scoreBreakdown) {
      return;
    }

    rows.push({
        recommendationRequestId: requestId,
        canonicalTrackId: candidate.canonicalTrackId,
        rank: index + 1,
        finalScore: candidate.scoreBreakdown.finalScore,
        components: normalizeJson(normalizeScoreComponents(candidate.scoreBreakdown)),
        penalties: normalizeJson(normalizePenaltyComponents(candidate.penaltiesApplied)),
    });
  });

  return rows;
}

function buildCandidateFeatureRows(requestId: string, candidates: RecommendationAuditCandidate[]) {
  return candidates.map((candidate) => ({
    recommendationRequestId: requestId,
    canonicalTrackId: candidate.canonicalTrackId,
    entityType: "candidate",
    entityId: candidate.canonicalTrackId,
    features: normalizeJson({
      scoreBreakdown: candidate.scoreBreakdown ?? null,
      penaltiesApplied: candidate.penaltiesApplied ?? null,
      track: compactTrackSnapshot(candidate),
    }),
  }));
}

function buildReasonRows(requestId: string, trace?: RecommendationAuditTrace | null) {
  if (!trace) {
    return [];
  }

  const generatedReasons = trace.generatedCandidates.map((candidate) => ({
    recommendationRequestId: requestId,
    canonicalTrackId: candidate.canonicalTrackId,
    candidateSnapshotId: null,
    reasonType: "candidate_generation",
    reasons: normalizeJson({
      sourceChannels: candidate.sourceChannels,
      mergedEvidence: candidate.mergedEvidence ?? [],
      channelWeights: candidate.channelWeights ?? {},
    }),
  }));
  const finalReasons = trace.recommendations.map((recommendation) => ({
    recommendationRequestId: requestId,
    canonicalTrackId: recommendation.canonicalTrackId,
    candidateSnapshotId: null,
    reasonType: "final_explanation",
    reasons: normalizeJson(recommendation.explanation ?? {}),
  }));

  return [...generatedReasons, ...finalReasons];
}

function buildFilterRows(requestId: string, trace?: RecommendationAuditTrace | null) {
  return (trace?.filterLogs ?? []).map((log) => ({
    recommendationRequestId: requestId,
    canonicalTrackId: log.canonicalTrackId,
    stage: log.stage,
    reason: log.reason,
    score: log.score ?? null,
    details: normalizeJson(log.details ?? {}),
  }));
}

function buildPoolHealthRows(input: BuildRecommendationAuditRowsInput) {
  if (!input.discoveryResult) {
    return [];
  }

  return [
    {
      recommendationRequestId: input.requestId,
      userId: input.userId,
      poolLevel: input.discoveryResult.poolLevel,
      health: normalizeJson(input.discoveryResult.health),
      plan: normalizeJson(input.discoveryResult.plan ?? null),
      queuedJobs: input.discoveryResult.queuedJobs,
      liveExpansion: normalizeJson(input.discoveryResult.liveExpansion ?? null),
    },
  ];
}

function buildDiscoveryJobRows(input: BuildRecommendationAuditRowsInput) {
  if (!input.discoveryResult) {
    return [];
  }

  return [
    {
      recommendationRequestId: input.requestId,
      discoveryJobId: null,
      seedId: null,
      action: "ensure_candidate_pool",
      jobType: null,
      status: input.discoveryResult.expanded ? "expanded" : "checked",
      providerId: null,
      providerCallCount: input.discoveryResult.liveExpansion?.providerCalls ?? 0,
      payload: normalizeJson({
        existingCount: input.discoveryResult.existingCount,
        poolLevel: input.discoveryResult.poolLevel,
        plan: input.discoveryResult.plan ?? null,
      }),
      resultSummary: normalizeJson({
        queuedJobs: input.discoveryResult.queuedJobs,
        ingestedTrackIds: input.discoveryResult.ingestedTrackIds,
        liveExpansion: input.discoveryResult.liveExpansion ?? null,
      }),
      rawPayload: null,
      rawPayloadBytes: null,
      rawPayloadExpiresAt: null,
    },
  ];
}

function evidenceString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function evidenceNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildGraphEdgeRows(requestId: string, trace?: RecommendationAuditTrace | null) {
  if (!trace) {
    return [];
  }

  return trace.generatedCandidates.flatMap((candidate) => {
    const evidence = candidate.mergedEvidence ?? [];

    return evidence.flatMap((entry) => {
      const rows: JsonRecord[] = [];
      const seedArtistId = evidenceString(entry.seedArtistId);
      const relatedArtistId = evidenceString(entry.relatedArtistId);
      const collaboratorArtistId = evidenceString(entry.collaboratorArtistId);
      const artistId = evidenceString(entry.artistId);
      const tagId = evidenceString(entry.tagId);
      const seedTrackId = evidenceString(entry.seedTrackId);
      const relationWeight = evidenceNumber(entry.relationWeight);
      const score = evidenceNumber(entry.score);

      if (seedArtistId && relatedArtistId) {
        rows.push({
          recommendationRequestId: requestId,
          candidateTrackId: candidate.canonicalTrackId,
          sourceNodeType: "Artist",
          sourceNodeId: seedArtistId,
          targetNodeType: "Artist",
          targetNodeId: relatedArtistId,
          edgeType: "similar_artist",
          weight: relationWeight,
          confidence: null,
          reason: "candidate_generation",
          evidence: normalizeJson(entry),
        });
      }

      if (seedArtistId && collaboratorArtistId) {
        rows.push({
          recommendationRequestId: requestId,
          candidateTrackId: candidate.canonicalTrackId,
          sourceNodeType: "Artist",
          sourceNodeId: seedArtistId,
          targetNodeType: "Artist",
          targetNodeId: collaboratorArtistId,
          edgeType: "collab",
          weight: relationWeight,
          confidence: null,
          reason: "candidate_generation",
          evidence: normalizeJson(entry),
        });
      }

      if (artistId) {
        rows.push({
          recommendationRequestId: requestId,
          candidateTrackId: candidate.canonicalTrackId,
          sourceNodeType: "Artist",
          sourceNodeId: artistId,
          targetNodeType: "RecommendationCandidate",
          targetNodeId: candidate.canonicalTrackId,
          edgeType: "recommended_from",
          weight: score,
          confidence: null,
          reason: "candidate_generation",
          evidence: normalizeJson(entry),
        });
      }

      if (tagId) {
        rows.push({
          recommendationRequestId: requestId,
          candidateTrackId: candidate.canonicalTrackId,
          sourceNodeType: "Tag",
          sourceNodeId: tagId,
          targetNodeType: "RecommendationCandidate",
          targetNodeId: candidate.canonicalTrackId,
          edgeType: "shared_tag",
          weight: score,
          confidence: null,
          reason: "candidate_generation",
          evidence: normalizeJson(entry),
        });
      }

      if (seedTrackId) {
        rows.push({
          recommendationRequestId: requestId,
          candidateTrackId: candidate.canonicalTrackId,
          sourceNodeType: "Track",
          sourceNodeId: seedTrackId,
          targetNodeType: "RecommendationCandidate",
          targetNodeId: candidate.canonicalTrackId,
          edgeType: "recommended_from",
          weight: score,
          confidence: null,
          reason: "candidate_generation",
          evidence: normalizeJson(entry),
        });
      }

      return rows;
    });
  });
}

export function buildRecommendationAuditRows(input: BuildRecommendationAuditRowsInput): RecommendationAuditRows {
  const now = input.now ?? new Date();
  const trace = input.trace ?? null;
  const generatedCandidates = trace?.generatedCandidates ?? [];
  const rankedCandidates = trace?.rankedCandidates ?? [];
  const finalRecommendationIds = new Set(
    trace?.recommendations.map((recommendation) => recommendation.canonicalTrackId) ?? [],
  );
  const finalCandidates = rankedCandidates.filter((candidate) => finalRecommendationIds.has(candidate.canonicalTrackId));

  return {
    request: {
      data: {
        id: input.requestId,
        userId: input.userId,
        surface: input.surface,
        mode: input.mode ?? input.context.mode ?? null,
        strategy: input.strategy ?? input.context.userFeatures?.strategy ?? null,
        contextSummary: input.contextSummary ?? input.context.userFeatures?.contextSummary ?? null,
        seed: normalizeJson(input.seed),
        input: normalizeJson(input.input ?? {}),
        userProfileSnapshot: normalizeJson(compactProfiles(input.profiles)),
        userFeatureSnapshot: normalizeJson(input.context.userFeatures ?? null),
        contextSnapshot: normalizeJson(compactContext(input.context)),
        poolHealthSnapshot: normalizeJson(input.discoveryResult?.health ?? null),
        candidateGeneratorSummary: normalizeJson(summarizeCandidateGenerators(generatedCandidates)),
        expansionSummary: normalizeJson(
          input.discoveryResult
            ? {
                expanded: input.discoveryResult.expanded,
                existingCount: input.discoveryResult.existingCount,
                poolLevel: input.discoveryResult.poolLevel,
                queuedJobs: input.discoveryResult.queuedJobs,
                ingestedTrackIds: input.discoveryResult.ingestedTrackIds,
                liveExpansion: input.discoveryResult.liveExpansion ?? null,
              }
            : null,
        ),
        finalRecommendations: normalizeJson(input.finalRecommendations),
        sampled: true,
        sampleRate: input.config.sampleRate,
        compact: input.config.compact,
        status: "completed",
        error: null,
        expiresAt: addDays(now, input.config.retentionDays),
        completedAt: now,
      },
    },
    candidateSnapshots: {
      data: [
        ...generatedCandidates.map((candidate) =>
          buildCandidateSnapshotRow({
            requestId: input.requestId,
            candidate,
            stage: "generated",
          }),
        ),
        ...finalCandidates.map((candidate, index) =>
          buildCandidateSnapshotRow({
            requestId: input.requestId,
            candidate,
            stage: "final",
            rank: index + 1,
            isFinal: true,
          }),
        ),
      ],
    },
    featureSnapshots: {
      data: [
        {
          recommendationRequestId: input.requestId,
          canonicalTrackId: null,
          entityType: "user_profile",
          entityId: input.userId,
          features: normalizeJson(compactProfiles(input.profiles)),
        },
        {
          recommendationRequestId: input.requestId,
          canonicalTrackId: null,
          entityType: "user_features",
          entityId: input.userId,
          features: normalizeJson(input.context.userFeatures ?? null),
        },
        {
          recommendationRequestId: input.requestId,
          canonicalTrackId: null,
          entityType: "request_context",
          entityId: input.userId,
          features: normalizeJson(compactContext(input.context)),
        },
        ...buildCandidateFeatureRows(input.requestId, rankedCandidates),
      ],
    },
    reasonSnapshots: {
      data: buildReasonRows(input.requestId, trace),
    },
    filterLogs: {
      data: buildFilterRows(input.requestId, trace),
    },
    scoreBreakdowns: {
      data: buildScoreBreakdownRows(input.requestId, rankedCandidates),
    },
    poolHealthSnapshots: {
      data: buildPoolHealthRows(input),
    },
    discoveryJobLogs: {
      data: buildDiscoveryJobRows(input),
    },
    providerResultLogs: {
      data: [],
    },
    graphEdgeAudits: {
      data: buildGraphEdgeRows(input.requestId, trace),
    },
  };
}

async function createManyIfNeeded(
  delegate: unknown,
  rows: CreateManyRows<JsonRecord>,
) {
  const createManyDelegate = delegate as { createMany(input: { data: JsonRecord[] }): Promise<unknown> } | undefined;
  if (!rows.data.length || !createManyDelegate) {
    return;
  }

  await createManyDelegate.createMany(rows);
}

export async function persistRecommendationAudit(prisma: PrismaClient, rows: RecommendationAuditRows) {
  try {
    await prisma.recommendationRequest.create(rows.request as never);
    await createManyIfNeeded(prisma.recommendationCandidateSnapshot, rows.candidateSnapshots);
    await createManyIfNeeded(prisma.recommendationFeatureSnapshot, rows.featureSnapshots);
    await createManyIfNeeded(prisma.recommendationReasonSnapshot, rows.reasonSnapshots);
    await createManyIfNeeded(prisma.recommendationFilterLog, rows.filterLogs);
    await createManyIfNeeded(prisma.recommendationScoreBreakdown, rows.scoreBreakdowns);
    await createManyIfNeeded(prisma.poolHealthSnapshot, rows.poolHealthSnapshots);
    await createManyIfNeeded(prisma.discoveryJobLog, rows.discoveryJobLogs);
    await createManyIfNeeded(prisma.providerResultLog, rows.providerResultLogs);
    await createManyIfNeeded(prisma.graphEdgeAudit, rows.graphEdgeAudits);

    return {
      persisted: true,
      error: null,
    };
  } catch (error) {
    return {
      persisted: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export async function persistRecommendationAuditTrace(prisma: PrismaClient, input: BuildRecommendationAuditRowsInput) {
  try {
    if (!shouldSampleRecommendationAudit(input.requestId, input.config)) {
      return {
        persisted: false,
        error: null,
      };
    }

    return persistRecommendationAudit(prisma, buildRecommendationAuditRows(input));
  } catch (error) {
    return {
      persisted: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
