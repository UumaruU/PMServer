import {
  PenaltyBreakdown,
  RecommendationCandidate,
  RecommendationCatalogSnapshot,
  RecommendationConfig,
  RecommendationContext,
  RecommendationProfiles,
  ScoreBreakdown,
} from "../types";

function weightedJaccard(left: Record<string, number>, right: Record<string, number>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let numerator = 0;
  let denominator = 0;

  keys.forEach((key) => {
    const leftWeight = left[key] ?? 0;
    const rightWeight = right[key] ?? 0;
    numerator += Math.min(leftWeight, rightWeight);
    denominator += Math.max(leftWeight, rightWeight);
  });

  return denominator > 0 ? numerator / denominator : 0;
}

function normalizeDurationScore(leftDurationMs: number | null | undefined, rightDurationMs: number | null | undefined) {
  if (!leftDurationMs || !rightDurationMs) {
    return 0;
  }

  const delta = Math.abs(leftDurationMs - rightDurationMs);
  if (delta <= 30_000) {
    return 1;
  }
  if (delta <= 60_000) {
    return 0.65;
  }
  if (delta <= 90_000) {
    return 0.35;
  }

  return 0;
}

function buildRecentArtistCounts(context: RecommendationContext) {
  return context.recentArtistIds.reduce<Record<string, number>>((accumulator, artistId) => {
    accumulator[artistId] = (accumulator[artistId] ?? 0) + 1;
    return accumulator;
  }, {});
}

function buildRecentTrackCounts(context: RecommendationContext) {
  return context.recentTrackIds.reduce<Record<string, number>>((accumulator, trackId) => {
    accumulator[trackId] = (accumulator[trackId] ?? 0) + 1;
    return accumulator;
  }, {});
}

function buildRecentReleaseCounts(snapshot: RecommendationCatalogSnapshot, context: RecommendationContext) {
  return context.recentTrackIds.reduce<Record<string, number>>((accumulator, trackId) => {
    const track = snapshot.tracksById[trackId];
    if (!track?.canonicalReleaseId) {
      return accumulator;
    }

    accumulator[track.canonicalReleaseId] = (accumulator[track.canonicalReleaseId] ?? 0) + 1;
    return accumulator;
  }, {});
}

function buildRecentTagCounts(snapshot: RecommendationCatalogSnapshot, context: RecommendationContext) {
  return context.recentTrackIds.reduce<Record<string, number>>((accumulator, trackId) => {
    const track = snapshot.tracksById[trackId];
    if (!track) {
      return accumulator;
    }

    track.tagIds.forEach((tagId) => {
      accumulator[tagId] = (accumulator[tagId] ?? 0) + 1;
    });
    return accumulator;
  }, {});
}

// Pure domain logic: scoring is deterministic and explainable for a fixed snapshot/context/config.
export function scoreCandidates(params: {
  candidates: RecommendationCandidate[];
  snapshot: RecommendationCatalogSnapshot;
  context: RecommendationContext;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const { candidates, snapshot, context, profiles, config } = params;
  const currentTrack = context.currentCanonicalTrackId
    ? snapshot.tracksById[context.currentCanonicalTrackId] ?? null
    : null;
  const recentArtistCounts = buildRecentArtistCounts(context);
  const recentTrackCounts = buildRecentTrackCounts(context);
  const recentReleaseCounts = buildRecentReleaseCounts(snapshot, context);
  const recentTagCounts = buildRecentTagCounts(snapshot, context);
  const sessionTagWeights = context.recentTagCloud;

  return candidates
    .map((candidate) => {
      const track = snapshot.tracksById[candidate.canonicalTrackId];
      if (!track) {
        return null;
      }

      const sameArtistScore =
        currentTrack?.primaryCanonicalArtistId && track.primaryCanonicalArtistId === currentTrack.primaryCanonicalArtistId
          ? 1
          : currentTrack?.featuringCanonicalArtistIds.some((artistId) =>
                track.canonicalArtistIds.includes(artistId),
              )
            ? 0.5
            : 0;

      const collaboratorScore =
        currentTrack?.primaryCanonicalArtistId && track.primaryCanonicalArtistId
          ? (snapshot.artistRelations[currentTrack.primaryCanonicalArtistId] ?? []).find(
              (edge) => edge.rightId === track.primaryCanonicalArtistId,
            )?.weight ?? 0
          : 0;

      const relatedArtistScore =
        currentTrack?.primaryCanonicalArtistId && track.primaryCanonicalArtistId
          ? (snapshot.relatedArtists[currentTrack.primaryCanonicalArtistId] ?? []).find(
              (edge) => edge.rightId === track.primaryCanonicalArtistId,
            )?.weight ?? 0
          : 0;

      const tagOverlapScore = weightedJaccard(
        currentTrack?.tagWeights ?? context.recentTagCloud,
        track.tagWeights,
      );
      const sessionFitScore = weightedJaccard(sessionTagWeights, track.tagWeights);

      const releaseProximityScore =
        currentTrack?.canonicalReleaseId && track.canonicalReleaseId === currentTrack.canonicalReleaseId
          ? 1
          : currentTrack?.canonicalReleaseId &&
              track.canonicalReleaseId &&
              (snapshot.releaseAdjacency[currentTrack.canonicalReleaseId] ?? []).includes(track.canonicalReleaseId)
            ? 0.4
            : currentTrack?.year && track.year && Math.abs(currentTrack.year - track.year) <= 2
              ? 0.25
              : 0;

      const tasteAffinityScore =
        (profiles.entity.trackAffinities[track.canonicalTrackId]?.value ?? 0) * 0.2 +
        (track.primaryCanonicalArtistId
          ? (profiles.entity.artistAffinities[track.primaryCanonicalArtistId]?.value ?? 0) * 0.12
          : 0) +
        track.tagIds.reduce(
          (accumulator, tagId) => accumulator + (profiles.entity.tagAffinities[tagId]?.value ?? 0) * 0.05,
          0,
        ) +
        (track.canonicalReleaseId ? (profiles.entity.releaseAffinities[track.canonicalReleaseId]?.value ?? 0) * 0.08 : 0);

      const durationFitScore = normalizeDurationScore(context.currentDurationMs ?? null, track.targetDurationMs);
      const flavorFitScore =
        context.currentFlavor && track.titleFlavor.includes(context.currentFlavor)
          ? 1
          : profiles.session.dominantFlavor && track.titleFlavor.includes(profiles.session.dominantFlavor)
            ? 0.75
            : track.titleFlavor.includes("original")
              ? 0.2
              : 0;
      const qualityScore =
        track.quality.clusterConfidence * 0.5 +
        track.quality.trustScore * 0.3 +
        track.quality.metadataCompleteness * 0.2;
      const availabilityScore = track.preferredVariantId && track.playableVariantIds.includes(track.preferredVariantId) ? 1 : 0;
      const popularityPriorScore = track.quality.popularityPrior;
      const noveltyScore = recentTrackCounts[track.canonicalTrackId] ? 0 : 1;

      const repetitionPenalty = Math.min(
        1,
        (track.primaryCanonicalArtistId ? (recentArtistCounts[track.primaryCanonicalArtistId] ?? 0) : 0) /
          Math.max(1, config.diversification.sameArtistStreak),
      );
      const duplicatePenalty = context.recentRecommendationIds.includes(track.canonicalTrackId) ? 1 : 0;
      const skipPenalty = context.skippedTrackIds.includes(track.canonicalTrackId) ? 1 : 0;
      const explicitMismatchPenalty =
        profiles.entity.dislikedTrackIds.includes(track.canonicalTrackId) ||
        profiles.session.recentDislikedTrackIds.includes(track.canonicalTrackId)
          ? 1
          : 0;

      const scoreBreakdown: ScoreBreakdown = {
        sameArtistScore,
        collaboratorScore,
        relatedArtistScore,
        tagOverlapScore,
        sessionFitScore,
        releaseProximityScore,
        tasteAffinityScore,
        durationFitScore,
        flavorFitScore,
        qualityScore,
        availabilityScore,
        popularityPriorScore,
        noveltyScore,
        finalScore: 0,
      };
      const penaltiesApplied: PenaltyBreakdown = {
        repetitionPenalty,
        duplicatePenalty,
        skipPenalty,
        explicitMismatchPenalty,
        totalPenalty: 0,
      };

      const weightedPositive =
        sameArtistScore * config.scoringWeights.sameArtist +
        collaboratorScore * config.scoringWeights.collaborator +
        relatedArtistScore * config.scoringWeights.relatedArtist +
        tagOverlapScore * config.scoringWeights.tagOverlap +
        sessionFitScore * config.scoringWeights.sessionFit +
        releaseProximityScore * config.scoringWeights.releaseProximity +
        tasteAffinityScore * config.scoringWeights.tasteAffinity +
        durationFitScore * config.scoringWeights.durationFit +
        flavorFitScore * config.scoringWeights.flavorFit +
        qualityScore * config.scoringWeights.quality +
        availabilityScore * config.scoringWeights.availability +
        popularityPriorScore * config.scoringWeights.popularityPrior +
        noveltyScore * config.scoringWeights.novelty;

      const weightedPenalty =
        repetitionPenalty * config.scoringWeights.repetitionPenalty +
        duplicatePenalty * config.scoringWeights.duplicatePenalty +
        skipPenalty * config.scoringWeights.skipPenalty +
        explicitMismatchPenalty * config.scoringWeights.explicitMismatchPenalty;

      penaltiesApplied.totalPenalty = weightedPenalty;
      scoreBreakdown.finalScore = weightedPositive - weightedPenalty;

      return {
        ...candidate,
        scoreBreakdown,
        penaltiesApplied,
        baseScore: scoreBreakdown.finalScore,
        __track: track,
        __recentArtistCounts: recentArtistCounts,
        __recentReleaseCounts: recentReleaseCounts,
        __recentTagCounts: recentTagCounts,
      };
    })
    .filter((candidate): candidate is RecommendationCandidate & {
      scoreBreakdown: ScoreBreakdown;
      penaltiesApplied: PenaltyBreakdown;
      __track: RecommendationCatalogSnapshot["tracksById"][string];
      __recentArtistCounts: Record<string, number>;
      __recentReleaseCounts: Record<string, number>;
      __recentTagCounts: Record<string, number>;
    } => !!candidate)
    .sort((left, right) => {
      if (left.scoreBreakdown.finalScore !== right.scoreBreakdown.finalScore) {
        return right.scoreBreakdown.finalScore - left.scoreBreakdown.finalScore;
      }

      if (left.scoreBreakdown.qualityScore !== right.scoreBreakdown.qualityScore) {
        return right.scoreBreakdown.qualityScore - left.scoreBreakdown.qualityScore;
      }

      return left.canonicalTrackId.localeCompare(right.canonicalTrackId);
    });
}
