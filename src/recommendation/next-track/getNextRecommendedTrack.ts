import { generateCandidates } from "../candidate-generation/generateCandidates";
import { buildExplanation } from "../debug/buildExplanation";
import { applyDiversification } from "../diversification/applyDiversification";
import { filterScoredCandidates } from "../filtering/filterCandidates";
import { scoreCandidates } from "../scoring/scoreCandidates";
import {
  RecommendedArtist,
  RecommendedTrack,
  RecommendationCatalogSnapshot,
  RecommendationConfig,
  RecommendationContext,
  RecommendationProfiles,
  RecommendationSeed,
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
export function getRankedTrackRecommendations(params: {
  seed: RecommendationSeed;
  context: RecommendationContext;
  snapshot: RecommendationCatalogSnapshot;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const generated = generateCandidates(params);
  const scored = scoreCandidates({
    candidates: generated,
    snapshot: params.snapshot,
    context: params.context,
    profiles: params.profiles,
    config: params.config,
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
    config: params.config,
  });

  return diversified.map((candidate, index) => {
    const explanation = buildExplanation({
      candidate,
      snapshot: params.snapshot,
      suppressedCompetitors: diversified
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
  const currentTrack = params.context.currentCanonicalTrackId
    ? params.snapshot.tracksById[params.context.currentCanonicalTrackId] ?? null
    : null;
  const currentArtistId = currentTrack?.primaryCanonicalArtistId ?? params.seed.canonicalArtistId ?? null;

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
        currentTrack?.tagIds ?? Object.keys(params.context.recentTagCloud),
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
