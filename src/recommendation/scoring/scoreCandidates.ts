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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function boundedPositive(rawValue: number, scale = 5) {
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return 0;
  }

  return 1 - Math.exp(-rawValue / Math.max(scale, 0.0001));
}

function countLeadingMatches(values: string[], expected: string | null | undefined) {
  if (!expected) {
    return 0;
  }

  let count = 0;
  for (const value of values) {
    if (value !== expected) {
      break;
    }

    count += 1;
  }

  return count;
}

function buildAntiRepeatArtistTrail(
  context: RecommendationContext,
  snapshot: RecommendationCatalogSnapshot,
) {
  const historyTrail = context.playbackPrimaryArtistId
    ? [context.playbackPrimaryArtistId, ...context.recentArtistIds]
    : context.recentArtistIds;
  const seenArtists = new Set(historyTrail);
  const recommendationTrail = (context.recentRecommendationIds ?? [])
    .map((trackId) => snapshot.tracksById[trackId]?.primaryCanonicalArtistId ?? null)
    .filter((artistId): artistId is string => !!artistId && !seenArtists.has(artistId));

  return [...historyTrail, ...recommendationTrail];
}

function getLeadingRecentArtistId(
  context: RecommendationContext,
  snapshot: RecommendationCatalogSnapshot,
) {
  return buildAntiRepeatArtistTrail(context, snapshot)[0] ?? null;
}

function countMatchesWithinWindow(values: string[], expected: string | null | undefined, limit: number) {
  if (!expected || limit <= 0) {
    return 0;
  }

  return values.slice(0, limit).reduce((count, value) => count + (value === expected ? 1 : 0), 0);
}

function computeCurrentArtistVarietyPressure(
  context: RecommendationContext,
  snapshot: RecommendationCatalogSnapshot,
) {
  const antiRepeatArtistTrail = buildAntiRepeatArtistTrail(context, snapshot);
  const leadingRecentArtistId = getLeadingRecentArtistId(context, snapshot);
  if (!leadingRecentArtistId) {
    return 0;
  }

  const leadingCurrentArtistCount = countLeadingMatches(antiRepeatArtistTrail, leadingRecentArtistId);
  if (leadingCurrentArtistCount < 2) {
    return 0;
  }

  const alternativeArtists = (context.userFeatures?.topArtists ?? []).filter((entry) => entry.id !== leadingRecentArtistId);
  const strongestAlternativeScore = alternativeArtists[0]?.score ?? 0;
  const meaningfulAlternativeCount = alternativeArtists.filter((entry) => entry.score >= 4).length;
  const meaningfulTagCount = (context.userFeatures?.topTags ?? []).filter((entry) => entry.score >= 3).length;

  if (meaningfulAlternativeCount === 0 && meaningfulTagCount < 2) {
    return 0;
  }

  return clamp(
    0.18 +
      Math.min(0.42, (leadingCurrentArtistCount - 1) * 0.18) +
      Math.min(0.18, strongestAlternativeScore / 30) +
      Math.min(0.16, meaningfulAlternativeCount * 0.04) +
      Math.min(0.12, meaningfulTagCount * 0.025),
    0,
    1,
  );
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

function buildRecentArtistCounts(
  context: RecommendationContext,
  snapshot: RecommendationCatalogSnapshot,
) {
  return buildAntiRepeatArtistTrail(context, snapshot).reduce<Record<string, number>>((accumulator, artistId) => {
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

function getRankedFeatureScore<T extends { id: string; score: number }>(entries: T[], id: string | null | undefined) {
  if (!id) {
    return 0;
  }

  return entries.find((entry) => entry.id === id)?.score ?? 0;
}

function hasMeaningfulArtistAlternatives(context: RecommendationContext) {
  return (context.userFeatures?.topArtists ?? []).filter((entry) => entry.score >= 4).length >= 2;
}

function sumTrackFeatureScores(params: {
  trackId: string;
  trackTagIds: string[];
  primaryArtistId?: string | null;
  releaseId?: string | null;
  context: RecommendationContext;
}) {
  const features = params.context.userFeatures;
  if (!features) {
    return 0;
  }

  return (
    getRankedFeatureScore(features.topTracks, params.trackId) * 0.1 +
    getRankedFeatureScore(features.topArtists, params.primaryArtistId) * 0.16 +
    getRankedFeatureScore(features.topReleases, params.releaseId) * 0.08 +
    params.trackTagIds.reduce((accumulator, tagId) => accumulator + getRankedFeatureScore(features.topTags, tagId) * 0.04, 0)
  );
}

function computeUserAffinityScore(params: {
  trackId: string;
  primaryArtistId?: string | null;
  releaseId?: string | null;
  tagIds: string[];
  profiles: RecommendationProfiles;
  context: RecommendationContext;
  preferredVariantId?: string | null;
}) {
  const { trackId, primaryArtistId, releaseId, tagIds, profiles, context, preferredVariantId } = params;
  const entityTrack = profiles.entity.trackAffinities[trackId]?.value ?? 0;
  const entityArtist = primaryArtistId ? profiles.entity.artistAffinities[primaryArtistId]?.value ?? 0 : 0;
  const entityRelease = releaseId ? profiles.entity.releaseAffinities[releaseId]?.value ?? 0 : 0;
  const entityTags = tagIds.reduce((accumulator, tagId) => accumulator + (profiles.entity.tagAffinities[tagId]?.value ?? 0), 0);
  const shortArtist = primaryArtistId ? profiles.shortTerm.artistAffinities[primaryArtistId]?.value ?? 0 : 0;
  const shortRelease = releaseId ? profiles.shortTerm.releaseAffinities[releaseId]?.value ?? 0 : 0;
  const shortTags = tagIds.reduce((accumulator, tagId) => accumulator + (profiles.shortTerm.tagAffinities[tagId]?.value ?? 0), 0);
  const longArtist = primaryArtistId ? profiles.longTerm.artistAffinities[primaryArtistId]?.value ?? 0 : 0;
  const longRelease = releaseId ? profiles.longTerm.releaseAffinities[releaseId]?.value ?? 0 : 0;
  const longTags = tagIds.reduce((accumulator, tagId) => accumulator + (profiles.longTerm.tagAffinities[tagId]?.value ?? 0), 0);
  const featureScore = sumTrackFeatureScores({
    trackId,
    trackTagIds: tagIds,
    primaryArtistId,
    releaseId,
    context,
  });
  const favoriteBoost =
    preferredVariantId && context.userFeatures?.favoriteVariantIds.includes(preferredVariantId) ? 0.35 : 0;
  const replayBoost = trackId ? (profiles.session.replayCountByTrackId[trackId] ?? 0) * 0.6 : 0;

  const rawAffinity =
    entityTrack * 0.2 +
    entityArtist * 0.12 +
    entityRelease * 0.07 +
    entityTags * 0.045 +
    shortArtist * 0.18 +
    shortRelease * 0.09 +
    shortTags * 0.05 +
    longArtist * 0.08 +
    longRelease * 0.05 +
    longTags * 0.025 +
    featureScore * 0.22 +
    favoriteBoost +
    replayBoost;

  return boundedPositive(rawAffinity, 7.5);
}

function computeRecentIntentScore(params: {
  trackId: string;
  trackTagIds: string[];
  primaryArtistId?: string | null;
  trackTagWeights: Record<string, number>;
  context: RecommendationContext;
}) {
  const sessionFitScore = weightedJaccard(params.context.recentTagCloud, params.trackTagWeights);
  const features = params.context.userFeatures;
  const searchTrack = features?.searchIntent.trackScores[params.trackId] ?? 0;
  const searchArtist = params.primaryArtistId ? features?.searchIntent.artistScores[params.primaryArtistId] ?? 0 : 0;
  const searchTags = params.trackTagIds.reduce(
    (accumulator, tagId) => accumulator + (features?.searchIntent.tagScores[tagId] ?? 0),
    0,
  );

  return clamp(sessionFitScore * 0.45 + boundedPositive(searchTrack + searchArtist + searchTags, 5) * 0.55, 0, 1);
}

function computeCooccurrenceScore(params: {
  trackId: string;
  context: RecommendationContext;
}) {
  const features = params.context.userFeatures;
  const playlistScore = features?.playlistTrackScores[params.trackId] ?? 0;
  const transitionScore = features?.sessionTransitionScores[params.trackId] ?? 0;
  return clamp(
    boundedPositive(playlistScore, 2.5) * 0.55 + boundedPositive(transitionScore, 2.1) * 0.45,
    0,
    1,
  );
}

function computeContextSignals(params: {
  snapshot: RecommendationCatalogSnapshot;
  context: RecommendationContext;
  trackId: string;
  primaryArtistId?: string | null;
  trackTagWeights: Record<string, number>;
  tagIds: string[];
  releaseId?: string | null;
  year?: number | null;
  titleFlavor: string[];
  targetDurationMs?: number | null;
}) {
  const currentTrack = params.context.currentCanonicalTrackId
    ? params.snapshot.tracksById[params.context.currentCanonicalTrackId] ?? null
    : null;
  const currentArtistVarietyPressure = computeCurrentArtistVarietyPressure(params.context, params.snapshot);
  const rawSameArtistScore =
    currentTrack?.primaryCanonicalArtistId && params.primaryArtistId === currentTrack.primaryCanonicalArtistId
      ? 1
      : currentTrack?.featuringCanonicalArtistIds.some((artistId) => artistId === params.primaryArtistId)
        ? 0.5
        : 0;
  const sameArtistScore =
    rawSameArtistScore > 0 ? rawSameArtistScore * (1 - currentArtistVarietyPressure * 0.85) : rawSameArtistScore;
  const collaboratorScore =
    currentTrack?.primaryCanonicalArtistId && params.primaryArtistId
      ? (params.snapshot.artistRelations[currentTrack.primaryCanonicalArtistId] ?? []).find(
          (edge) => edge.rightId === params.primaryArtistId,
        )?.weight ?? 0
      : 0;
  const relatedArtistScore =
    currentTrack?.primaryCanonicalArtistId && params.primaryArtistId
      ? (params.snapshot.relatedArtists[currentTrack.primaryCanonicalArtistId] ?? []).find(
          (edge) => edge.rightId === params.primaryArtistId,
        )?.weight ?? 0
      : 0;
  const tagOverlapScore = weightedJaccard(currentTrack?.tagWeights ?? {}, params.trackTagWeights);
  const releaseProximityScore =
    currentTrack?.canonicalReleaseId && params.releaseId === currentTrack.canonicalReleaseId
      ? 1
      : currentTrack?.canonicalReleaseId &&
          params.releaseId &&
          (params.snapshot.releaseAdjacency[currentTrack.canonicalReleaseId] ?? []).includes(params.releaseId)
        ? 0.45
        : currentTrack?.year && params.year && Math.abs(currentTrack.year - params.year) <= 2
          ? 0.25
          : 0;
  const durationFitScore = normalizeDurationScore(params.context.currentDurationMs ?? null, params.targetDurationMs);
  const flavorFitScore =
    params.context.currentFlavor && params.titleFlavor.includes(params.context.currentFlavor)
      ? 1
      : params.context.sessionTasteProfile?.dominantFlavor &&
          params.titleFlavor.includes(params.context.sessionTasteProfile.dominantFlavor)
        ? 0.75
        : params.titleFlavor.includes("original")
          ? 0.2
          : 0;
  const contextScore = clamp(
    sameArtistScore * 0.28 +
      collaboratorScore * 0.2 +
      relatedArtistScore * 0.16 +
      tagOverlapScore * 0.16 +
      releaseProximityScore * 0.12 +
      durationFitScore * 0.04 +
      flavorFitScore * 0.04,
    0,
    1,
  );

  return {
    sameArtistScore,
    collaboratorScore,
    relatedArtistScore,
    tagOverlapScore,
    releaseProximityScore,
    durationFitScore,
    flavorFitScore,
    contextScore,
  };
}

function computeExplorationScore(params: {
  candidate: RecommendationCandidate;
  trackId: string;
  primaryArtistId?: string | null;
  context: RecommendationContext;
}) {
  const recentlySeen = params.context.recentRecommendationIds.includes(params.trackId) || params.context.recentTrackIds.includes(params.trackId);
  const noveltyScore = recentlySeen ? 0.15 : 1;
  const discoveryLevel = params.context.userFeatures?.strategy === "cold-start" ? "safe" : null;
  const discoveryBonus =
    (params.candidate.sourceChannels.includes("adjacentDiscovery") ? 0.55 : 0) +
    (params.candidate.sourceChannels.includes("safeExploration") ? (discoveryLevel === "safe" ? 0.25 : 0.45) : 0) +
    (params.candidate.sourceChannels.includes("relatedArtists") ? 0.22 : 0) +
    (params.candidate.sourceChannels.includes("frequentCollaborators") ? 0.24 : 0) +
    (params.candidate.sourceChannels.includes("sharedTags") ? 0.2 : 0) +
    (params.candidate.sourceChannels.includes("searchIntent") ? 0.15 : 0);

  return {
    noveltyScore,
    explorationScore: clamp(noveltyScore * 0.65 + discoveryBonus * 0.35 + boundedPositive(params.candidate.baseScore, 4) * 0.15, 0, 1),
  };
}

function computeArtistVarietyBoost(params: {
  primaryArtistId?: string | null;
  candidate: RecommendationCandidate;
  context: RecommendationContext;
  profiles: RecommendationProfiles;
  snapshot: RecommendationCatalogSnapshot;
}) {
  const artistId = params.primaryArtistId;
  if (!artistId) {
    return 0;
  }

  if (artistId === getLeadingRecentArtistId(params.context, params.snapshot)) {
    return 0;
  }

  const leadingRecentArtistCount = countLeadingMatches(
    buildAntiRepeatArtistTrail(params.context, params.snapshot),
    artistId,
  );
  if (leadingRecentArtistCount > 0) {
    return 0;
  }

  const topArtistScore = getRankedFeatureScore(params.context.userFeatures?.topArtists ?? [], artistId);
  const entityAffinity = params.profiles.entity.artistAffinities[artistId]?.value ?? 0;
  const shortTermAffinity = params.profiles.shortTerm.artistAffinities[artistId]?.value ?? 0;
  const longTermAffinity = params.profiles.longTerm.artistAffinities[artistId]?.value ?? 0;
  const currentArtistVarietyPressure = computeCurrentArtistVarietyPressure(params.context, params.snapshot);
  const discoveryBridgeBonus =
    (params.candidate.sourceChannels.includes("adjacentDiscovery") ? 0.16 : 0) +
    (params.candidate.sourceChannels.includes("safeExploration") ? 0.12 : 0) +
    (params.candidate.sourceChannels.includes("relatedArtists") ? 0.08 : 0) +
    (params.candidate.sourceChannels.includes("frequentCollaborators") ? 0.12 : 0) +
    (params.candidate.sourceChannels.includes("sharedTags") ? 0.1 : 0);
  const affinitySignal = boundedPositive(
    entityAffinity * 1.15 + shortTermAffinity * 1.1 + longTermAffinity * 0.7 + topArtistScore * 0.18,
    6,
  );
  const alternativeRecoveryBonus =
    currentArtistVarietyPressure > 0
      ? currentArtistVarietyPressure *
        clamp(
          (params.candidate.sourceChannels.includes("userTopArtists") ? 0.26 : 0) +
            (params.candidate.sourceChannels.includes("adjacentDiscovery") ? 0.24 : 0) +
            (params.candidate.sourceChannels.includes("relatedArtists") ? 0.16 : 0) +
            (params.candidate.sourceChannels.includes("frequentCollaborators") ? 0.18 : 0) +
            (params.candidate.sourceChannels.includes("sharedTags") ? 0.16 : 0) +
            boundedPositive(topArtistScore, 10) * 0.18,
          0,
          0.72,
        )
      : 0;

  return clamp(affinitySignal * 0.55 + discoveryBridgeBonus + alternativeRecoveryBonus, 0, 1.15);
}

// Pure domain logic: scoring emphasizes user taste, recent intent and co-occurrence, while capping context influence from the current track.
export function scoreCandidates(params: {
  candidates: RecommendationCandidate[];
  snapshot: RecommendationCatalogSnapshot;
  context: RecommendationContext;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const { candidates, snapshot, context, profiles, config } = params;
  const recentArtistCounts = buildRecentArtistCounts(context, snapshot);
  const recentTrackCounts = buildRecentTrackCounts(context);
  const recentReleaseCounts = buildRecentReleaseCounts(snapshot, context);
  const recentTagCounts = buildRecentTagCounts(snapshot, context);
  const currentArtistVarietyPressure = computeCurrentArtistVarietyPressure(context, snapshot);
  const leadingRecentArtistId = getLeadingRecentArtistId(context, snapshot);
  const artistCooldownLookback = Math.max(0, (config.diversification.artistCooldownWindow ?? 10) - 1);

  return candidates
    .map((candidate) => {
      const track = snapshot.tracksById[candidate.canonicalTrackId];
      if (!track) {
        return null;
      }

      const contextSignals = computeContextSignals({
        snapshot,
        context,
        trackId: track.canonicalTrackId,
        primaryArtistId: track.primaryCanonicalArtistId,
        trackTagWeights: track.tagWeights,
        tagIds: track.tagIds,
        releaseId: track.canonicalReleaseId,
        year: track.year,
        titleFlavor: track.titleFlavor,
        targetDurationMs: track.targetDurationMs,
      });
      const userAffinityScore = computeUserAffinityScore({
        trackId: track.canonicalTrackId,
        primaryArtistId: track.primaryCanonicalArtistId,
        releaseId: track.canonicalReleaseId,
        tagIds: track.tagIds,
        profiles,
        context,
        preferredVariantId: track.preferredVariantId,
      });
      const recentIntentScore = computeRecentIntentScore({
        trackId: track.canonicalTrackId,
        trackTagIds: track.tagIds,
        primaryArtistId: track.primaryCanonicalArtistId,
        trackTagWeights: track.tagWeights,
        context,
      });
      const cooccurrenceScore = computeCooccurrenceScore({
        trackId: track.canonicalTrackId,
        context,
      });
      const qualityScore =
        track.quality.clusterConfidence * 0.42 +
        track.quality.trustScore * 0.33 +
        track.quality.metadataCompleteness * 0.25;
      const availabilityScore = track.preferredVariantId && track.playableVariantIds.includes(track.preferredVariantId) ? 1 : 0;
      const qualityAvailabilityScore = clamp(qualityScore * 0.72 + availabilityScore * 0.28, 0, 1);
      const popularityPriorScore = track.quality.popularityPrior;
      const explorationSignals = computeExplorationScore({
        candidate,
        trackId: track.canonicalTrackId,
        primaryArtistId: track.primaryCanonicalArtistId,
        context,
      });

      const userAffinityContribution = userAffinityScore * config.userCentricBlend.userAffinity * 10;
      const recentIntentContribution = recentIntentScore * config.userCentricBlend.recentIntent * 10;
      const cooccurrenceContribution = cooccurrenceScore * config.userCentricBlend.cooccurrence * 10;
      const qualityAvailabilityContribution = qualityAvailabilityScore * config.userCentricBlend.qualityAvailability * 10;
      const noveltyExplorationContribution = explorationSignals.explorationScore * config.userCentricBlend.noveltyExploration * 10;
      const positiveWithoutContext =
        userAffinityContribution +
        recentIntentContribution +
        cooccurrenceContribution +
        qualityAvailabilityContribution +
        noveltyExplorationContribution;
      const rawContextContribution = contextSignals.contextScore * config.userCentricBlend.currentTrackContext * 10;
      const maxContextContribution =
        positiveWithoutContext > 0
          ? (positiveWithoutContext * config.userCentricBlend.currentTrackContextMaxShare) /
            Math.max(0.01, 1 - config.userCentricBlend.currentTrackContextMaxShare)
          : config.userCentricBlend.currentTrackContext * 2.5;
      const contextContribution = Math.min(rawContextContribution, maxContextContribution);

      const repeatedArtistCount = track.primaryCanonicalArtistId ? recentArtistCounts[track.primaryCanonicalArtistId] ?? 0 : 0;
      const repeatedReleaseCount = track.canonicalReleaseId ? recentReleaseCounts[track.canonicalReleaseId] ?? 0 : 0;
      const repeatedTagCount = track.tagIds.reduce((max, tagId) => Math.max(max, recentTagCounts[tagId] ?? 0), 0);
      const antiRepeatArtistTrail = buildAntiRepeatArtistTrail(context, snapshot);
      const immediateArtistLoopCount = countLeadingMatches(antiRepeatArtistTrail, track.primaryCanonicalArtistId);
      const artistCooldownMatches = countMatchesWithinWindow(
        antiRepeatArtistTrail,
        track.primaryCanonicalArtistId,
        artistCooldownLookback,
      );
      const hasArtistAlternatives = hasMeaningfulArtistAlternatives(context);
      const dominantUserArtistId = context.userFeatures?.topArtists[0]?.id ?? null;
      const dominantArtistSaturationPenalty =
        track.primaryCanonicalArtistId &&
        dominantUserArtistId &&
        track.primaryCanonicalArtistId === dominantUserArtistId &&
        dominantUserArtistId !== leadingRecentArtistId &&
        (context.userFeatures?.topTags ?? []).filter((entry) => entry.score >= 3).length >= 2
          ? hasArtistAlternatives
            ? 0.22 +
              (candidate.sourceChannels.includes("userTopArtists") ? 0.34 : 0) +
              (candidate.sourceChannels.includes("adjacentDiscovery") ? 0.2 : 0) +
              (candidate.sourceChannels.includes("sharedTags") ? 0.08 : 0) +
              currentArtistVarietyPressure * 0.12
            : 0.08
          : 0;
      const isExactFavorite =
        context.favoritedTrackIds.includes(track.canonicalTrackId) ||
        (!!track.preferredVariantId && context.userFeatures?.favoriteVariantIds.includes(track.preferredVariantId));
      const favoriteReplayPenalty = isExactFavorite
        ? context.userFeatures?.searchIntent.trackScores[track.canonicalTrackId]
          ? 0.1
          : 0.7
        : 0;
      const immediateArtistLoopPenalty =
        track.primaryCanonicalArtistId && track.primaryCanonicalArtistId === leadingRecentArtistId
          ? hasArtistAlternatives
            ? 0.45 +
              currentArtistVarietyPressure * 0.55 +
              Math.max(0, immediateArtistLoopCount - 1) * (0.28 + currentArtistVarietyPressure * 0.24)
            : 0.08 + Math.max(0, immediateArtistLoopCount - 1) * 0.08
          : immediateArtistLoopCount > 0
            ? (hasArtistAlternatives ? 0.18 + currentArtistVarietyPressure * 0.08 : 0.06) * immediateArtistLoopCount
            : 0;
      const repetitionPenalty = clamp(
        repeatedArtistCount /
          Math.max(1, config.diversification.sameArtistStreak) *
          (hasArtistAlternatives ? 0.65 + currentArtistVarietyPressure * 0.45 : 0.22) +
          (artistCooldownMatches > 0
            ? (hasArtistAlternatives ? 1.15 : 0.15) + Math.max(0, artistCooldownMatches - 1) * (hasArtistAlternatives ? 0.25 : 0.05)
            : 0) +
          repeatedReleaseCount /
            Math.max(1, config.diversification.sameReleaseStreak) *
            (hasArtistAlternatives ? 0.35 : 0.14) +
          repeatedTagCount /
            Math.max(1, config.diversification.sameNarrowTagClusterStreak) *
            (hasArtistAlternatives ? 0.2 : 0.08) +
          immediateArtistLoopPenalty +
          dominantArtistSaturationPenalty +
          favoriteReplayPenalty,
        0,
        2.45,
      );
      const duplicatePenalty = context.recentRecommendationIds.includes(track.canonicalTrackId)
        ? 1
        : recentTrackCounts[track.canonicalTrackId]
          ? 0.35
          : 0;
      const skipPenalty =
        context.skippedTrackIds.includes(track.canonicalTrackId) ||
        profiles.session.recentSkippedTrackIds.includes(track.canonicalTrackId) ||
        profiles.session.recentFastSkippedTrackIds.includes(track.canonicalTrackId)
          ? 1
          : 0;
      const explicitMismatchPenalty =
        (context.userFeatures?.negative.fatiguePenaltyByTrackId[track.canonicalTrackId] ?? 0) +
        boundedPositive(
          candidate.sourceChannels.reduce(
            (accumulator, channel) => accumulator + (profiles.session.channelPenalties[channel] ?? 0),
            0,
          ),
          5,
        ) *
          0.35;
      const artistVarietyBoost = computeArtistVarietyBoost({
        primaryArtistId: track.primaryCanonicalArtistId,
        candidate,
        context,
        profiles,
        snapshot,
      });

      const scoreBreakdown: ScoreBreakdown = {
        sameArtistScore: contextSignals.sameArtistScore,
        collaboratorScore: contextSignals.collaboratorScore,
        relatedArtistScore: contextSignals.relatedArtistScore,
        tagOverlapScore: contextSignals.tagOverlapScore,
        sessionFitScore: weightedJaccard(context.recentTagCloud, track.tagWeights),
        releaseProximityScore: contextSignals.releaseProximityScore,
        tasteAffinityScore: userAffinityScore,
        durationFitScore: contextSignals.durationFitScore,
        flavorFitScore: contextSignals.flavorFitScore,
        qualityScore,
        availabilityScore,
        popularityPriorScore,
        noveltyScore: explorationSignals.noveltyScore,
        userAffinityScore,
        recentIntentScore,
        cooccurrenceScore,
        contextScore: contextSignals.contextScore,
        explorationScore: explorationSignals.explorationScore,
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
        positiveWithoutContext + contextContribution + popularityPriorScore * 0.45 + artistVarietyBoost;
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

      if (left.scoreBreakdown.userAffinityScore !== right.scoreBreakdown.userAffinityScore) {
        return right.scoreBreakdown.userAffinityScore - left.scoreBreakdown.userAffinityScore;
      }

      return left.canonicalTrackId.localeCompare(right.canonicalTrackId);
    });
}
