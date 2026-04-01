import {
  RecommendationCandidate,
  RecommendationCatalogSnapshot,
  RecommendationChannel,
  RecommendationConfig,
  RecommendationContext,
  RecommendationProfiles,
  RecommendationSeed,
} from "../types";

function compareLexical(left: string, right: string) {
  return left.localeCompare(right);
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

function computeExplorationPressure(context: RecommendationContext, profiles: RecommendationProfiles) {
  const discoveryLevel = profiles.bootstrap.discoveryLevel ?? "balanced";
  const topArtistCount = (context.userFeatures?.topArtists ?? []).filter((entry) => entry.score >= 4).length;
  const topTagCount = (context.userFeatures?.topTags ?? []).filter((entry) => entry.score >= 3).length;
  const base =
    discoveryLevel === "safe"
      ? 0.08
      : discoveryLevel === "exploratory"
        ? 0.4
        : 0.24;
  const ceiling =
    discoveryLevel === "safe"
      ? 0.18
      : discoveryLevel === "exploratory"
        ? 0.8
        : 0.52;

  return clamp(
    base +
      Math.min(0.18, Math.max(0, topTagCount - 2) * 0.03) +
      Math.min(0.12, Math.max(0, topArtistCount - 1) * 0.03),
    0,
    ceiling,
  );
}

function pushCandidate(
  bag: Map<string, RecommendationCandidate>,
  canonicalTrackId: string,
  channel: RecommendationChannel,
  weight: number,
  evidence: Record<string, unknown>,
) {
  if (!Number.isFinite(weight) || weight <= 0) {
    return;
  }

  const existing = bag.get(canonicalTrackId);
  if (existing) {
    existing.sourceChannels = [...new Set([...existing.sourceChannels, channel])].sort(compareLexical);
    existing.channelWeights[channel] = Math.max(existing.channelWeights[channel] ?? 0, weight);
    existing.mergedEvidence.push(evidence);
    existing.baseScore += weight;
    return;
  }

  bag.set(canonicalTrackId, {
    canonicalTrackId,
    sourceChannels: [channel],
    channelWeights: { [channel]: weight },
    mergedEvidence: [evidence],
    baseScore: weight,
  });
}

function topAffinityKeys(entries: Record<string, { value: number }>, limit: number) {
  return Object.entries(entries)
    .sort((left, right) => {
      if (left[1].value !== right[1].value) {
        return right[1].value - left[1].value;
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([key]) => key);
}

function pushArtistTrackCandidates(params: {
  bag: Map<string, RecommendationCandidate>;
  snapshot: RecommendationCatalogSnapshot;
  artistId: string;
  channel: RecommendationChannel;
  weight: number;
  evidence: Record<string, unknown>;
  limit: number;
}) {
  (params.snapshot.artistToTracks[params.artistId] ?? [])
    .slice(0, params.limit)
    .forEach((trackId) => pushCandidate(params.bag, trackId, params.channel, params.weight, params.evidence));
}

function pushTagTrackCandidates(params: {
  bag: Map<string, RecommendationCandidate>;
  snapshot: RecommendationCatalogSnapshot;
  tagId: string;
  channel: RecommendationChannel;
  weight: number;
  evidence: Record<string, unknown>;
  limit: number;
}) {
  (params.snapshot.tagToTracks[params.tagId] ?? [])
    .slice(0, params.limit)
    .forEach((trackId) => pushCandidate(params.bag, trackId, params.channel, params.weight, params.evidence));
}

function pushTagArtistCandidates(params: {
  bag: Map<string, RecommendationCandidate>;
  snapshot: RecommendationCatalogSnapshot;
  tagId: string;
  channel: RecommendationChannel;
  weight: number;
  evidence: Record<string, unknown>;
  artistLimit: number;
  trackLimitPerArtist: number;
  knownArtistIds: Set<string>;
  preferNovelArtists: boolean;
}) {
  (params.snapshot.tagToArtists[params.tagId] ?? [])
    .map((artistId) => {
      const artist = params.snapshot.artistsById[artistId];
      if (!artist) {
        return null;
      }

      const knownArtist = params.knownArtistIds.has(artistId);
      const rankScore =
        (artist.tagWeights[params.tagId] ?? 0) * 0.6 +
        artist.quality.trustScore * 0.22 +
        artist.quality.metadataCompleteness * 0.18 +
        (params.preferNovelArtists && !knownArtist ? 0.28 : 0);

      return {
        artistId,
        knownArtist,
        rankScore,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        artistId: string;
        knownArtist: boolean;
        rankScore: number;
      } => !!entry,
    )
    .sort((left, right) => {
      if (left.rankScore !== right.rankScore) {
        return right.rankScore - left.rankScore;
      }

      return left.artistId.localeCompare(right.artistId);
    })
    .slice(0, params.artistLimit)
    .forEach((entry) =>
      pushArtistTrackCandidates({
        bag: params.bag,
        snapshot: params.snapshot,
        artistId: entry.artistId,
        channel: params.channel,
        weight: params.weight * (entry.knownArtist ? 0.78 : 1.08),
        evidence: {
          ...params.evidence,
          artistId: entry.artistId,
          knownArtist: entry.knownArtist,
        },
        limit: params.trackLimitPerArtist,
      }),
    );
}

function pushSafeExploration(params: {
  bag: Map<string, RecommendationCandidate>;
  snapshot: RecommendationCatalogSnapshot;
  context: RecommendationContext;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const topTagScoreById = Object.fromEntries(
    (params.context.userFeatures?.topTags ?? [])
      .slice(0, 8)
      .map((entry) => [entry.id, entry.score]),
  );
  const topTagIds = Object.keys(topTagScoreById);
  const topArtistIds = params.context.userFeatures?.topArtists.slice(0, 6).map((entry) => entry.id) ?? [];
  const knownArtistIds = new Set(topArtistIds);
  const discoveryLevel = params.profiles.bootstrap.discoveryLevel ?? "balanced";
  const maxPool = params.config.candidatePoolSizes.safeExploration;
  const discoveryLift =
    discoveryLevel === "safe"
      ? 0.08
      : discoveryLevel === "exploratory"
        ? 0.26
        : 0.18;

  Object.values(params.snapshot.tracksById)
    .filter((track) => {
      if (params.context.currentCanonicalTrackId === track.canonicalTrackId) {
        return false;
      }

      if (!track.preferredVariantId || !track.playableVariantIds.includes(track.preferredVariantId)) {
        return false;
      }

      const tagMatch = track.tagIds.some((tagId) => topTagIds.includes(tagId));
      const artistMatch = !!track.primaryCanonicalArtistId && topArtistIds.includes(track.primaryCanonicalArtistId);
      if (discoveryLevel === "safe") {
        return tagMatch || artistMatch;
      }

      if (discoveryLevel === "balanced") {
        return tagMatch || artistMatch || track.quality.popularityPrior >= 0.15;
      }

      return tagMatch || artistMatch || track.quality.popularityPrior >= 0.1;
    })
    .map((track) => {
      const tagMatchStrength = track.tagIds.reduce(
        (best, tagId) => Math.max(best, (topTagScoreById[tagId] ?? 0) / 12),
        0,
      );
      const artistMatch = !!track.primaryCanonicalArtistId && knownArtistIds.has(track.primaryCanonicalArtistId);
      const novelArtist = !!track.primaryCanonicalArtistId && !knownArtistIds.has(track.primaryCanonicalArtistId);
      const rankScore =
        tagMatchStrength * 0.45 +
        (novelArtist ? 0.24 + discoveryLift : artistMatch ? 0.12 : 0) +
        track.quality.popularityPrior * 0.22 +
        track.quality.trustScore * 0.18 +
        track.quality.metadataCompleteness * 0.15;

      return {
        track,
        tagMatchStrength,
        artistMatch,
        novelArtist,
        rankScore,
      };
    })
    .sort((left, right) => {
      if (left.rankScore !== right.rankScore) {
        return right.rankScore - left.rankScore;
      }

      return left.track.canonicalTrackId.localeCompare(right.track.canonicalTrackId);
    })
    .slice(0, maxPool)
    .forEach(({ track, tagMatchStrength, artistMatch, novelArtist }) => {
      pushCandidate(params.bag, track.canonicalTrackId, "safeExploration", 0.14 +
        tagMatchStrength * 0.38 +
        (novelArtist ? 0.24 + discoveryLift : 0.06 + (artistMatch ? 0.04 : 0)) +
        track.quality.popularityPrior * 0.16, {
        discoveryLevel,
        tagMatchStrength,
        artistMatch,
        novelArtist,
        popularityPrior: track.quality.popularityPrior,
      });
    });
}

// Pure domain logic: candidate generation uses only user profile/history signals and ignores the currently playing track as a seed.
export function generateCandidates(params: {
  seed: RecommendationSeed;
  context: RecommendationContext;
  snapshot: RecommendationCatalogSnapshot;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const { seed, context, snapshot, profiles, config } = params;
  const candidates = new Map<string, RecommendationCandidate>();
  const userFeatures = context.userFeatures;
  void seed;
  const currentCanonicalTrackId = context.currentCanonicalTrackId ?? null;
  const leadingRecentArtistId = getLeadingRecentArtistId(context, snapshot);
  const currentArtistVarietyPressure = computeCurrentArtistVarietyPressure(context, snapshot);
  const explorationPressure = computeExplorationPressure(context, profiles);
  const hasDiscoveryDepth =
    currentArtistVarietyPressure > 0 ||
    (userFeatures?.topArtists ?? []).filter((entry) => entry.score >= 4).length >= 2 ||
    (userFeatures?.topTags ?? []).filter((entry) => entry.score >= 3).length >= 2;
  const artistCooldownLookback = Math.max(0, (config.diversification.artistCooldownWindow ?? 10) - 1);
  const recentArtistCooldownSet = new Set(
    buildAntiRepeatArtistTrail(context, snapshot).slice(0, artistCooldownLookback),
  );
  const knownTopArtistIds = new Set((userFeatures?.topArtists ?? []).slice(0, 10).map((entry) => entry.id));

  (userFeatures?.topArtists ?? []).slice(0, 10).forEach((entry) => {
    const isLeadingRecentArtist = entry.id === leadingRecentArtistId;
    const isArtistOnCooldown = recentArtistCooldownSet.has(entry.id);
    const topArtistWeightBase =
      (0.56 + Math.min(1.45, entry.score / 7.5)) *
      (1 - explorationPressure * 0.18) *
      (isArtistOnCooldown && hasDiscoveryDepth
        ? 1 - Math.min(0.72, 0.42 + currentArtistVarietyPressure * 0.2)
        : 1);
    const topArtistWeight = isLeadingRecentArtist
      ? topArtistWeightBase * (1 - currentArtistVarietyPressure * 0.55)
      : topArtistWeightBase +
        (isArtistOnCooldown ? 0 : currentArtistVarietyPressure * Math.min(0.8, 0.14 + entry.score / 18));
    const topArtistLimit = isLeadingRecentArtist
      ? Math.max(12, Math.floor(config.candidatePoolSizes.userTopArtists * (1 - currentArtistVarietyPressure * 0.7)))
      : isArtistOnCooldown && hasDiscoveryDepth
        ? Math.max(4, Math.floor(config.candidatePoolSizes.userTopArtists * 0.22))
        : Math.max(12, Math.floor(config.candidatePoolSizes.userTopArtists * (1 - explorationPressure * 0.18)));

    pushArtistTrackCandidates({
      bag: candidates,
      snapshot,
      artistId: entry.id,
      channel: "userTopArtists",
      weight: topArtistWeight,
      evidence: { artistId: entry.id, score: entry.score },
      limit: topArtistLimit,
    });

    (snapshot.relatedArtists[entry.id] ?? []).slice(0, 5).forEach((relatedArtist) => {
      pushArtistTrackCandidates({
        bag: candidates,
        snapshot,
        artistId: relatedArtist.rightId,
        channel: "relatedArtists",
        weight:
          0.32 +
          relatedArtist.weight * (0.95 + explorationPressure * 0.35) +
          (isLeadingRecentArtist
            ? currentArtistVarietyPressure * 0.26
            : currentArtistVarietyPressure * 0.08 + explorationPressure * 0.12),
        evidence: {
          seedArtistId: entry.id,
          relatedArtistId: relatedArtist.rightId,
          relationWeight: relatedArtist.weight,
        },
        limit: Math.max(10, Math.floor(config.candidatePoolSizes.relatedArtists / 2)),
      });
    });

    (snapshot.artistRelations[entry.id] ?? []).slice(0, 5).forEach((relatedArtist) => {
      pushArtistTrackCandidates({
        bag: candidates,
        snapshot,
        artistId: relatedArtist.rightId,
        channel: "frequentCollaborators",
        weight:
          0.3 +
          relatedArtist.weight * (0.95 + explorationPressure * 0.28) +
          (isLeadingRecentArtist
            ? currentArtistVarietyPressure * 0.22
            : currentArtistVarietyPressure * 0.06 + explorationPressure * 0.1),
        evidence: {
          seedArtistId: entry.id,
          collaboratorArtistId: relatedArtist.rightId,
          relationWeight: relatedArtist.weight,
        },
        limit: Math.max(10, Math.floor(config.candidatePoolSizes.frequentCollaborators / 2)),
      });
    });
  });

  (userFeatures?.topTags ?? []).slice(0, 12).forEach((entry) => {
    pushTagTrackCandidates({
      bag: candidates,
      snapshot,
      tagId: entry.id,
      channel: "userTopTags",
      weight: 0.46 + Math.min(1.1, entry.score / 8.5),
      evidence: { tagId: entry.id, score: entry.score },
      limit: config.candidatePoolSizes.userTopTags,
    });

    pushTagArtistCandidates({
      bag: candidates,
      snapshot,
      tagId: entry.id,
      channel: "sharedTags",
      weight: 0.18 + Math.min(0.95, entry.score / 10) + explorationPressure * 0.32,
      evidence: { tagId: entry.id, score: entry.score },
      artistLimit: Math.max(6, Math.floor(config.candidatePoolSizes.sharedTags / 8)),
      trackLimitPerArtist: Math.max(3, Math.floor(config.candidatePoolSizes.sharedTags / 12)),
      knownArtistIds: knownTopArtistIds,
      preferNovelArtists: true,
    });
  });

  (userFeatures?.topTracks ?? []).slice(0, 10).forEach((entry) => {
    const track = snapshot.tracksById[entry.id];
    if (!track) {
      return;
    }
    const isExactFavorite =
      context.favoritedTrackIds.includes(track.canonicalTrackId) ||
      (!!track.preferredVariantId && !!userFeatures?.favoriteVariantIds.includes(track.preferredVariantId));

    pushCandidate(
      candidates,
      track.canonicalTrackId,
      "userTopTracks",
      isExactFavorite
        ? 0.08 + Math.min(0.22, entry.score / 40)
        : (0.56 + Math.min(0.95, entry.score / 10)) * (1 - explorationPressure * 0.12),
      {
        canonicalTrackId: track.canonicalTrackId,
        score: entry.score,
        isExactFavorite,
      },
    );

    if (track.canonicalReleaseId) {
      (snapshot.releaseToTracks[track.canonicalReleaseId] ?? [])
        .filter((trackId) => trackId !== track.canonicalTrackId)
        .slice(0, Math.max(10, Math.floor(config.candidatePoolSizes.releaseEraProximity / 2)))
        .forEach((trackId) =>
          pushCandidate(candidates, trackId, "releaseEraProximity", 0.35 + Math.min(0.8, entry.score / 18), {
            seedTrackId: track.canonicalTrackId,
            canonicalReleaseId: track.canonicalReleaseId,
          }),
        );
    }

    if (track.primaryCanonicalArtistId) {
      const seedArtistOnCooldown = recentArtistCooldownSet.has(track.primaryCanonicalArtistId);
      (snapshot.artistToTracks[track.primaryCanonicalArtistId] ?? [])
        .filter((trackId) => trackId !== track.canonicalTrackId)
        .slice(0, Math.max(10, Math.floor(config.candidatePoolSizes.adjacentDiscovery / 2)))
        .forEach((trackId) =>
          pushCandidate(
            candidates,
            trackId,
            "adjacentDiscovery",
            (0.18 + Math.min(0.48, entry.score / 26)) *
              (seedArtistOnCooldown && hasDiscoveryDepth
                ? 0.18 + (1 - currentArtistVarietyPressure) * 0.14
                : track.primaryCanonicalArtistId === leadingRecentArtistId
                ? 1 - currentArtistVarietyPressure * 0.7
                : 1 - explorationPressure * 0.22),
            {
              seedTrackId: track.canonicalTrackId,
              artistId: track.primaryCanonicalArtistId,
            },
          ),
        );
    }
  });

  Object.entries(userFeatures?.playlistTrackScores ?? {})
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, config.candidatePoolSizes.playlistCooccurrence)
    .forEach(([trackId, score]) =>
      pushCandidate(candidates, trackId, "playlistCooccurrence", 0.35 + Math.min(1.2, score), {
        canonicalTrackId: trackId,
        score,
      }),
    );

  Object.entries(userFeatures?.sessionTransitionScores ?? {})
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, config.candidatePoolSizes.sessionTransitions)
    .forEach(([trackId, score]) =>
      pushCandidate(candidates, trackId, "sessionTransitions", 0.3 + Math.min(1.15, score), {
        canonicalTrackId: trackId,
        score,
      }),
    );

  Object.entries(userFeatures?.searchIntent.trackScores ?? {})
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, config.candidatePoolSizes.searchIntent)
    .forEach(([trackId, score]) =>
      pushCandidate(candidates, trackId, "searchIntent", 0.35 + Math.min(1.35, score / 3), {
        canonicalTrackId: trackId,
        score,
      }),
    );

  Object.entries(userFeatures?.searchIntent.artistScores ?? {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .forEach(([artistId, score]) =>
      pushArtistTrackCandidates({
        bag: candidates,
        snapshot,
        artistId,
        channel: "searchIntent",
        weight: 0.25 + Math.min(1.1, score / 3.5),
        evidence: { artistId, score },
        limit: Math.max(10, Math.floor(config.candidatePoolSizes.searchIntent / 2)),
      }),
    );

  Object.entries(userFeatures?.searchIntent.tagScores ?? {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .forEach(([tagId, score]) =>
      pushTagTrackCandidates({
        bag: candidates,
        snapshot,
        tagId,
        channel: "searchIntent",
        weight: 0.2 + Math.min(1, score / 4),
        evidence: { tagId, score },
        limit: Math.max(10, Math.floor(config.candidatePoolSizes.searchIntent / 2)),
      }),
    );

  topAffinityKeys(profiles.entity.trackAffinities, 8).forEach((trackId) => {
    if (snapshot.tracksById[trackId]) {
      pushCandidate(candidates, trackId, "userAffinityRetrieval", profiles.entity.trackAffinities[trackId]?.value ?? 0, {
        affinityTrackId: trackId,
      });
    }
  });

  Object.entries(context.recentTagCloud)
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, config.candidatePoolSizes.sessionContinuation)
    .forEach(([tagId, weight]) => {
      (snapshot.tagToTracks[tagId] ?? []).forEach((trackId) => {
        pushCandidate(candidates, trackId, "sessionContinuation", Math.min(0.9, 0.12 + weight * 0.35), { tagId });
      });
    });

  pushSafeExploration({
    bag: candidates,
    snapshot,
    context,
    profiles,
    config,
  });

  return [...candidates.values()]
    .filter((candidate) => candidate.canonicalTrackId !== currentCanonicalTrackId)
    .sort((left, right) => {
      if (left.baseScore !== right.baseScore) {
        return right.baseScore - left.baseScore;
      }

      return left.canonicalTrackId.localeCompare(right.canonicalTrackId);
    });
}
