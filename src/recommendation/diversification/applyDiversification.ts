import {
  RecommendationCatalogSnapshot,
  RecommendationConfig,
  RecommendationContext,
  RecommendationProfiles,
} from "../types";

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

const TITLE_TOKEN_STOPWORDS = new Set([
  "feat",
  "ft",
  "with",
  "and",
  "the",
  "from",
  "remix",
  "edit",
  "radio",
  "live",
  "version",
  "official",
  "audio",
  "video",
]);

function getTitleTokens(track: RecommendationCatalogSnapshot["tracksById"][string] | undefined) {
  return (track?.normalizedTitleCore ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 4 && !TITLE_TOKEN_STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function hasMeaningfulArtistAlternatives(context: RecommendationContext) {
  return (context.userFeatures?.topArtists ?? []).filter((entry) => entry.score >= 4).length >= 2;
}

function strongArtistRepeatInterest(artistId: string | null | undefined, profiles: RecommendationProfiles, context: RecommendationContext) {
  if (!artistId) {
    return false;
  }

  const leadingArtistLoop = countLeadingMatches(context.recentArtistIds, artistId);
  if (leadingArtistLoop >= 2) {
    return false;
  }

  const entityAffinity = profiles.entity.artistAffinities[artistId]?.value ?? 0;
  const shortTermAffinity = profiles.shortTerm.artistAffinities[artistId]?.value ?? 0;
  const topArtistScore = context.userFeatures?.topArtists.find((entry) => entry.id === artistId)?.score ?? 0;
  return entityAffinity >= 8 || shortTermAffinity >= 5.5 || topArtistScore >= 18;
}

function looksLikeNearDuplicate(
  left: RecommendationCatalogSnapshot["tracksById"][string] | undefined,
  right: RecommendationCatalogSnapshot["tracksById"][string] | undefined,
) {
  if (!left || !right) {
    return false;
  }

  if (left.canonicalTrackId === right.canonicalTrackId) {
    return true;
  }

  if (left.musicBrainzRecordingId && right.musicBrainzRecordingId && left.musicBrainzRecordingId === right.musicBrainzRecordingId) {
    return true;
  }

  if (left.normalizedTitleCore === right.normalizedTitleCore && left.primaryCanonicalArtistId === right.primaryCanonicalArtistId) {
    return true;
  }

  if (left.canonicalReleaseId && right.canonicalReleaseId && left.canonicalReleaseId === right.canonicalReleaseId) {
    return left.primaryCanonicalArtistId === right.primaryCanonicalArtistId;
  }

  return false;
}

function cloneCandidate<T extends { scoreBreakdown: { finalScore: number }; penaltiesApplied: { repetitionPenalty: number; totalPenalty: number } }>(
  candidate: T,
) {
  return {
    ...candidate,
    scoreBreakdown: {
      ...candidate.scoreBreakdown,
    },
    penaltiesApplied: {
      ...candidate.penaltiesApplied,
    },
  };
}

function buildRecentTitleTokenCounts(
  context: RecommendationContext,
  snapshot: RecommendationCatalogSnapshot,
) {
  return [...context.recentTrackIds, ...(context.recentRecommendationIds ?? [])].reduce<Record<string, number>>(
    (accumulator, trackId) => {
      getTitleTokens(snapshot.tracksById[trackId]).forEach((token) => {
        accumulator[token] = (accumulator[token] ?? 0) + 1;
      });

      return accumulator;
    },
    {},
  );
}

function hasFreshTitleTokenAlternative<T extends { __track: RecommendationCatalogSnapshot["tracksById"][string] }>(
  candidates: T[],
  titleTokenCounts: Record<string, number>,
) {
  return candidates.some((candidate) => getTitleTokens(candidate.__track).every((token) => (titleTokenCounts[token] ?? 0) < 2));
}

// Pure domain logic: final ordering uses greedy reranking with diversity caps and avoids near-duplicate runs.
export function applyDiversification<
  T extends {
    canonicalTrackId: string;
    scoreBreakdown: { finalScore: number };
    penaltiesApplied: { repetitionPenalty: number; totalPenalty: number };
    __track: RecommendationCatalogSnapshot["tracksById"][string];
  },
>(params: {
  candidates: T[];
  snapshot: RecommendationCatalogSnapshot;
  context: RecommendationContext;
  profiles: RecommendationProfiles;
  config: RecommendationConfig;
}) {
  const remaining = params.candidates.map((candidate) => cloneCandidate(candidate));
  const selected: typeof remaining = [];
  const leadingRecentArtistId = getLeadingRecentArtistId(params.context, params.snapshot);
  const artistCooldownLookback = Math.max(0, (params.config.diversification.artistCooldownWindow ?? 10) - 1);
  const baseHasArtistAlternatives = hasMeaningfulArtistAlternatives(params.context);
  const antiRepeatArtistTrail = buildAntiRepeatArtistTrail(params.context, params.snapshot);
  const recentArtistTrail = antiRepeatArtistTrail.slice(0, artistCooldownLookback);
  const favoriteArtistTrail = (params.context.favoritedTrackIds ?? [])
    .map((trackId) => params.snapshot.tracksById[trackId]?.primaryCanonicalArtistId ?? null)
    .filter((artistId): artistId is string => !!artistId);
  const favoriteArtistIds = new Set(favoriteArtistTrail);
  const artistCounts = antiRepeatArtistTrail
    .slice(0, Math.max(artistCooldownLookback, 6))
    .reduce<Record<string, number>>((accumulator, artistId) => {
      accumulator[artistId] = (accumulator[artistId] ?? 0) + 1;
      return accumulator;
    }, {});
  const releaseCounts = params.context.recentTrackIds
    .slice(0, 6)
    .reduce<Record<string, number>>((accumulator, trackId) => {
      const track = params.snapshot.tracksById[trackId];
      if (!track?.canonicalReleaseId) {
        return accumulator;
      }

      accumulator[track.canonicalReleaseId] = (accumulator[track.canonicalReleaseId] ?? 0) + 1;
      return accumulator;
    }, {});
  const tagCounts = [...params.context.recentTrackIds, ...(params.context.recentRecommendationIds ?? [])]
    .slice(0, 6)
    .reduce<Record<string, number>>((accumulator, trackId) => {
      const track = params.snapshot.tracksById[trackId];
      if (!track) {
        return accumulator;
      }

      track.tagIds.forEach((tagId) => {
        accumulator[tagId] = (accumulator[tagId] ?? 0) + 1;
      });

      return accumulator;
    }, {});
  const titleTokenCounts = buildRecentTitleTokenCounts(params.context, params.snapshot);

  while (remaining.length) {
    const poolOffCooldownArtists = new Set(
      remaining
        .map((candidate) => candidate.__track.primaryCanonicalArtistId)
        .filter((artistId): artistId is string => !!artistId && !recentArtistTrail.includes(artistId)),
    );
    const hasPoolArtistAlternatives = poolOffCooldownArtists.size >= 1;
    const hasArtistAlternatives = baseHasArtistAlternatives || hasPoolArtistAlternatives;
    const hasTitleTokenAlternatives = hasFreshTitleTokenAlternative(remaining, titleTokenCounts);
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const track = candidate.__track;
      const selectedCount = selected.length;
      const currentArtistCount = track.primaryCanonicalArtistId ? artistCounts[track.primaryCanonicalArtistId] ?? 0 : 0;
      const currentReleaseCount = track.canonicalReleaseId ? releaseCounts[track.canonicalReleaseId] ?? 0 : 0;
      const repeatedTagCount = track.tagIds.reduce((max, tagId) => Math.max(max, tagCounts[tagId] ?? 0), 0);
      const titleTokens = getTitleTokens(track);
      const repeatedTitleTokenCount = titleTokens.reduce(
        (max, token) => Math.max(max, titleTokenCounts[token] ?? 0),
        0,
      );
      const repeatInterest = strongArtistRepeatInterest(track.primaryCanonicalArtistId, params.profiles, params.context);
      const artistCooldownMatches = countMatchesWithinWindow(
        recentArtistTrail,
        track.primaryCanonicalArtistId,
        artistCooldownLookback,
      );
      const artistCooldownActive = artistCooldownMatches > 0;
      const isFavoriteArtist = !!track.primaryCanonicalArtistId && favoriteArtistIds.has(track.primaryCanonicalArtistId);

      if (selectedCount === 0 && isFavoriteArtist && hasPoolArtistAlternatives) {
        continue;
      }

      if (selectedCount < 10) {
        if (track.primaryCanonicalArtistId && currentArtistCount >= 1 && hasPoolArtistAlternatives) {
          continue;
        }

        if (track.canonicalReleaseId && currentReleaseCount >= 2) {
          continue;
        }

        if (repeatedTagCount >= 3) {
          continue;
        }

        if (repeatedTitleTokenCount >= 2 && hasTitleTokenAlternatives) {
          continue;
        }
      }

      if (
        hasArtistAlternatives &&
        artistCooldownActive &&
        track.primaryCanonicalArtistId &&
        (!repeatInterest || hasPoolArtistAlternatives)
      ) {
        continue;
      }

      const shouldBlockImmediateArtistRepeat =
        hasArtistAlternatives &&
        track.primaryCanonicalArtistId &&
        selectedCount < 10 &&
        (!repeatInterest || hasPoolArtistAlternatives) &&
        (track.primaryCanonicalArtistId === leadingRecentArtistId || currentArtistCount >= 2);

      if (shouldBlockImmediateArtistRepeat) {
        continue;
      }

      if (selectedCount < 5 && looksLikeNearDuplicate(track, selected[selected.length - 1]?.__track)) {
        continue;
      }

      let extraPenalty = 0;
      if (currentArtistCount > 0) {
        extraPenalty += repeatInterest
          ? (hasArtistAlternatives ? 0.16 : 0.08) * currentArtistCount
          : (hasArtistAlternatives ? 0.34 : 0.14) * currentArtistCount;
      }

      if (artistCooldownActive) {
        extraPenalty += hasArtistAlternatives ? 1.35 + Math.max(0, artistCooldownMatches - 1) * 0.2 : 0.2;
      }

      if (currentReleaseCount > 0) {
        extraPenalty += 0.3 * currentReleaseCount;
      }

      if (repeatedTagCount > 0) {
        extraPenalty += 0.12 * repeatedTagCount;
      }

      if (repeatedTitleTokenCount > 0) {
        extraPenalty += hasTitleTokenAlternatives ? 0.32 * repeatedTitleTokenCount : 0.08 * repeatedTitleTokenCount;
      }

      if (selectedCount < 5 && looksLikeNearDuplicate(track, selected[selected.length - 2]?.__track)) {
        extraPenalty += 0.5;
      }

      const rerankedScore = candidate.scoreBreakdown.finalScore - extraPenalty;
      if (rerankedScore > bestScore) {
        bestScore = rerankedScore;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const track = candidate.__track;
        const currentArtistCount = track.primaryCanonicalArtistId ? artistCounts[track.primaryCanonicalArtistId] ?? 0 : 0;
        const currentReleaseCount = track.canonicalReleaseId ? releaseCounts[track.canonicalReleaseId] ?? 0 : 0;
        const repeatedTagCount = track.tagIds.reduce((max, tagId) => Math.max(max, tagCounts[tagId] ?? 0), 0);
        const repeatedTitleTokenCount = getTitleTokens(track).reduce(
          (max, token) => Math.max(max, titleTokenCounts[token] ?? 0),
          0,
        );
        const repeatInterest = strongArtistRepeatInterest(track.primaryCanonicalArtistId, params.profiles, params.context);
        const artistCooldownMatches = countMatchesWithinWindow(
          recentArtistTrail,
          track.primaryCanonicalArtistId,
          artistCooldownLookback,
        );
        const fallbackPenalty =
          (currentArtistCount > 0
            ? (repeatInterest
                ? (hasArtistAlternatives ? 0.1 : 0.04)
                : (hasArtistAlternatives ? 0.18 : 0.08)) * currentArtistCount
            : 0) +
          (artistCooldownMatches > 0 ? (hasArtistAlternatives ? 0.45 : 0.08) + Math.max(0, artistCooldownMatches - 1) * 0.05 : 0) +
          (currentReleaseCount > 0 ? 0.08 * currentReleaseCount : 0) +
          (repeatedTagCount > 0 ? 0.04 * repeatedTagCount : 0) +
          (repeatedTitleTokenCount > 0 ? (hasTitleTokenAlternatives ? 0.16 : 0.04) * repeatedTitleTokenCount : 0);
        const fallbackScore = candidate.scoreBreakdown.finalScore - fallbackPenalty;

        if (fallbackScore > bestScore) {
          bestScore = fallbackScore;
          bestIndex = index;
        }
      }
    }

    if (bestIndex < 0) {
      break;
    }

    const [picked] = remaining.splice(bestIndex, 1);
    const track = picked.__track;
    const artistCount = track.primaryCanonicalArtistId ? artistCounts[track.primaryCanonicalArtistId] ?? 0 : 0;
    const releaseCount = track.canonicalReleaseId ? releaseCounts[track.canonicalReleaseId] ?? 0 : 0;
    const repeatedTagCount = track.tagIds.reduce((max, tagId) => Math.max(max, tagCounts[tagId] ?? 0), 0);
    const repeatedTitleTokenCount = getTitleTokens(track).reduce(
      (max, token) => Math.max(max, titleTokenCounts[token] ?? 0),
      0,
    );
    const repeatInterest = strongArtistRepeatInterest(track.primaryCanonicalArtistId, params.profiles, params.context);
    const artistCooldownMatches = countMatchesWithinWindow(
      recentArtistTrail,
      track.primaryCanonicalArtistId,
      artistCooldownLookback,
    );
    const finalExtraPenalty =
      (artistCount > 0
        ? (repeatInterest
            ? (hasArtistAlternatives ? 0.16 : 0.08)
            : (hasArtistAlternatives ? 0.34 : 0.14)) * artistCount
        : 0) +
      (artistCooldownMatches > 0
        ? (hasArtistAlternatives ? 1.35 : 0.2) + Math.max(0, artistCooldownMatches - 1) * (hasArtistAlternatives ? 0.2 : 0.05)
        : 0) +
      (releaseCount > 0 ? 0.3 * releaseCount : 0) +
      (repeatedTagCount > 0 ? 0.12 * repeatedTagCount : 0) +
      (repeatedTitleTokenCount > 0 ? (hasTitleTokenAlternatives ? 0.32 : 0.08) * repeatedTitleTokenCount : 0);

    picked.penaltiesApplied.repetitionPenalty += finalExtraPenalty;
    picked.penaltiesApplied.totalPenalty += finalExtraPenalty;
    picked.scoreBreakdown.finalScore -= finalExtraPenalty;
    selected.push(picked);

    if (track.primaryCanonicalArtistId) {
      artistCounts[track.primaryCanonicalArtistId] = (artistCounts[track.primaryCanonicalArtistId] ?? 0) + 1;
      recentArtistTrail.unshift(track.primaryCanonicalArtistId);
      if (artistCooldownLookback > 0) {
        recentArtistTrail.splice(artistCooldownLookback);
      } else {
        recentArtistTrail.length = 0;
      }
    }

    if (track.canonicalReleaseId) {
      releaseCounts[track.canonicalReleaseId] = (releaseCounts[track.canonicalReleaseId] ?? 0) + 1;
    }

    track.tagIds.forEach((tagId) => {
      tagCounts[tagId] = (tagCounts[tagId] ?? 0) + 1;
    });
    getTitleTokens(track).forEach((token) => {
      titleTokenCounts[token] = (titleTokenCounts[token] ?? 0) + 1;
    });
  }

  return selected;
}
