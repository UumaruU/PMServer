import { generateCandidates } from "../candidate-generation/generateCandidates";
import { buildExplanation } from "../debug/buildExplanation";
import { applyDiversification } from "../diversification/applyDiversification";
import { explainScoredCandidateFilter, filterScoredCandidates, type RecommendationFilterReason } from "../filtering/filterCandidates";
import { scoreCandidates } from "../scoring/scoreCandidates";
import {
  PenaltyBreakdown,
  RecommendationCandidate,
  RecommendedArtist,
  RecommendedTrack,
  RecommendationCatalogSnapshot,
  RecommendationConfig,
  RecommendationContext,
  RecommendationProfiles,
  RecommendationSeed,
  ScoreBreakdown,
} from "../types";

function topTagOverlapForArtist(
  snapshot: RecommendationCatalogSnapshot,
  currentTagIds: string[],
  candidateArtistId: string,
) {
  const candidate = snapshot.artistsById[candidateArtistId];
  if (!candidate) {
    return 0;
  }

  const overlapCount = candidate.tagIds.filter((tagId) => currentTagIds.includes(tagId)).length;
  return candidate.tagIds.length ? overlapCount / candidate.tagIds.length : 0;
}

// Pure domain logic: next-track orchestration is deterministic and only depends on snapshot/context/profiles/config.
export type ScoredRecommendationCandidate = RecommendationCandidate & {
  scoreBreakdown: ScoreBreakdown;
  penaltiesApplied: PenaltyBreakdown;
  __track: RecommendationCatalogSnapshot["tracksById"][string];
  __recentArtistCounts: Record<string, number>;
  __recentReleaseCounts: Record<string, number>;
  __recentTagCounts: Record<string, number>;
};

export interface RecommendationFilterLogEntry {
  canonicalTrackId: string;
  stage: "hard_filter";
  reason: RecommendationFilterReason;
  score: number;
  details: Record<string, unknown>;
}

export interface RankedTrackRecommendationTrace {
  generatedCandidates: RecommendationCandidate[];
  scoredCandidates: ScoredRecommendationCandidate[];
  filterLogs: RecommendationFilterLogEntry[];
  rankedCandidates: ScoredRecommendationCandidate[];
  recommendations: RecommendedTrack[];
}

function buildRecommendedTracks(
  candidates: ScoredRecommendationCandidate[],
  snapshot: RecommendationCatalogSnapshot,
) {
  return candidates.map((candidate, index) => {
    const explanation = buildExplanation({
      candidate,
      snapshot,
      suppressedCompetitors: candidates
        .filter((_, competitorIndex) => competitorIndex > index && competitorIndex < index + 4)
        .map((competitor) => ({
          canonicalTrackId: competitor.canonicalTrackId,
          finalScore: competitor.scoreBreakdown.finalScore,
        })),
    });

    return {
      canonicalTrackId: candidate.canonicalTrackId,
      preferredVariantId: candidate.__track.preferredVariantId ?? "",
      sourceChannels: candidate.sourceChannels,
      score: candidate.scoreBreakdown.finalScore,
      explanation,
    } satisfies RecommendedTrack;
  });
}

export function getRankedTrackRecommendationTrace(params: {
  seed: RecommendationSeed;
  context: RecommendationContext;
  snapshot: RecommendationCatalogSnapshot;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}): RankedTrackRecommendationTrace {
  const generated = generateCandidates(params);
  const scored = scoreCandidates({
    candidates: generated,
    snapshot: params.snapshot,
    context: params.context,
    profiles: params.profiles,
    config: params.config,
  });
  const filterLogs = scored.flatMap((candidate) => {
    const decision = explainScoredCandidateFilter({
      candidate,
      snapshot: params.snapshot,
      context: params.context,
      profiles: params.profiles,
      minCanonicalConfidence: params.config.filtering.minCanonicalConfidence,
    });

    if (decision.included || !decision.reason) {
      return [];
    }

    return [
      {
        canonicalTrackId: candidate.canonicalTrackId,
        stage: "hard_filter" as const,
        reason: decision.reason,
        score: candidate.scoreBreakdown.finalScore,
        details: {
          ...(decision.details ?? {}),
          sourceChannels: candidate.sourceChannels,
          preferredVariantId: candidate.__track.preferredVariantId ?? null,
        },
      },
    ];
  });
  const filtered = filterScoredCandidates({
    candidates: scored,
    snapshot: params.snapshot,
    context: params.context,
    profiles: params.profiles,
    config: params.config,
  });
  const diversified = applyDiversification({
    candidates: filtered,
    snapshot: params.snapshot,
    context: params.context,
    profiles: params.profiles,
    config: params.config,
  });

  return {
    generatedCandidates: generated,
    scoredCandidates: scored,
    filterLogs,
    rankedCandidates: diversified,
    recommendations: buildRecommendedTracks(diversified, params.snapshot),
  };
}

export function getRankedTrackRecommendations(params: {
  seed: RecommendationSeed;
  context: RecommendationContext;
  snapshot: RecommendationCatalogSnapshot;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  return getRankedTrackRecommendationTrace(params).recommendations;
}

export function getBestNextTrack(params: {
  seed: RecommendationSeed;
  context: RecommendationContext;
  snapshot: RecommendationCatalogSnapshot;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  return getRankedTrackRecommendations(params)[0] ?? null;
}

export function getRankedArtistRecommendations(params: {
  seed: RecommendationSeed;
  context: RecommendationContext;
  snapshot: RecommendationCatalogSnapshot;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const currentArtistId = params.seed.canonicalArtistId ?? null;

  return Object.values(params.snapshot.artistsById)
    .filter((artist) => artist.canonicalArtistId !== currentArtistId)
    .map((artist) => {
      const collaborationWeight = currentArtistId
        ? (params.snapshot.artistRelations[currentArtistId] ?? []).find((edge) => edge.rightId === artist.canonicalArtistId)
            ?.weight ?? 0
        : 0;
      const relatedGraphWeight = currentArtistId
        ? (params.snapshot.relatedArtists[currentArtistId] ?? []).find((edge) => edge.rightId === artist.canonicalArtistId)
            ?.weight ?? 0
        : 0;
      const tagOverlap = topTagOverlapForArtist(
        params.snapshot,
        Object.keys(params.context.recentTagCloud),
        artist.canonicalArtistId,
      );
      const userArtistAffinity = params.profiles.entity.artistAffinities[artist.canonicalArtistId]?.value ?? 0;
      const popularityPrior =
        artist.trackIds.reduce(
          (best, trackId) => Math.max(best, params.snapshot.tracksById[trackId]?.quality.popularityPrior ?? 0),
          0,
        ) ?? 0;
      const repetitionPenalty = params.context.recentArtistIds.includes(artist.canonicalArtistId) ? 1 : 0;
      const score =
        tagOverlap * params.config.scoringWeights.tagOverlap +
        collaborationWeight * params.config.scoringWeights.collaborator +
        relatedGraphWeight * params.config.scoringWeights.relatedArtist +
        userArtistAffinity * 0.15 +
        popularityPrior * params.config.scoringWeights.popularityPrior -
        repetitionPenalty * params.config.scoringWeights.repetitionPenalty;

      return {
        canonicalArtistId: artist.canonicalArtistId,
        score,
        sourceChannels: [
          collaborationWeight > 0 ? "frequentCollaborators" : null,
          relatedGraphWeight > 0 ? "relatedArtists" : null,
          tagOverlap > 0 ? "sharedTags" : null,
          userArtistAffinity > 0 ? "userAffinityRetrieval" : null,
        ].filter((value): value is RecommendedArtist["sourceChannels"][number] => !!value),
        topReasons: [
          collaborationWeight > 0 ? "collaboration" : null,
          relatedGraphWeight > 0 ? "related-artist-graph" : null,
          tagOverlap > 0 ? "tag-overlap" : null,
          userArtistAffinity > 0 ? "user-affinity" : null,
        ].filter((value): value is string => !!value),
        scoreBreakdown: {
          tagOverlap,
          collaborationWeight,
          relatedGraphWeight,
          userArtistAffinity,
          popularityPrior,
          repetitionPenalty,
        },
      } satisfies RecommendedArtist;
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      return left.canonicalArtistId.localeCompare(right.canonicalArtistId);
    });
}
