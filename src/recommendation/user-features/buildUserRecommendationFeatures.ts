import { recommendationNormalizationService } from "../canonical-graph/normalization";
import type {
  CanonicalTrack,
  RankedFeatureEntry,
  RecommendationCatalogSnapshot,
  RecommendationConfig,
  RecommendationContext,
  RecommendationProfiles,
  RecommendationSearchIntentSummary,
  UserRecommendationFeatures,
} from "../types";

interface UserFeatureFavorite {
  canonicalTrackId: string;
  createdAt: string;
}

interface UserFeatureHistoryEvent {
  canonicalTrackId: string;
  createdAt: string;
  eventType: string;
  playedMs?: number | null;
}

interface UserFeaturePlaylist {
  id: string;
  canonicalTrackIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface UserFeatureSearchEntry {
  query: string;
  createdAt: string;
}

interface UserFeatureRecommendationEvent {
  eventType: string;
  canonicalTrackId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecommendationUserStateFeaturesInput {
  favorites: UserFeatureFavorite[];
  historyEvents: UserFeatureHistoryEvent[];
  playlists: UserFeaturePlaylist[];
  searchHistory: UserFeatureSearchEntry[];
  recommendationEvents: UserFeatureRecommendationEvent[];
  favoriteVariantIds: string[];
  now: number;
}

function addScore(target: Record<string, number>, key: string | null | undefined, delta: number) {
  if (!key || !Number.isFinite(delta) || delta === 0) {
    return;
  }

  target[key] = (target[key] ?? 0) + delta;
}

function normalizeTimestamp(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recencyWeight(now: number, occurredAt: string, halfLifeMs: number) {
  const timestamp = normalizeTimestamp(occurredAt);
  if (!timestamp || halfLifeMs <= 0) {
    return 1;
  }

  const ageMs = Math.max(0, now - timestamp);
  return Math.exp(-ageMs / halfLifeMs);
}

function toRankedEntries(
  scores: Record<string, number>,
  limit: number,
  minimumScore = 0.05,
): RankedFeatureEntry[] {
  return Object.entries(scores)
    .filter(([, score]) => score >= minimumScore)
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}

function trackHasQueryMatch(track: CanonicalTrack, normalizedQuery: string) {
  if (!normalizedQuery) {
    return false;
  }

  return (
    track.normalizedTitleCore.includes(normalizedQuery) ||
    normalizedQuery.includes(track.normalizedTitleCore) ||
    track.title.toLowerCase().includes(normalizedQuery)
  );
}

function buildSearchIntentSummary(params: {
  snapshot: RecommendationCatalogSnapshot;
  favorites: UserFeatureFavorite[];
  historyEvents: UserFeatureHistoryEvent[];
  searchHistory: UserFeatureSearchEntry[];
  config: RecommendationConfig;
  now: number;
}) {
  const queries = params.searchHistory
    .slice()
    .sort((left, right) => normalizeTimestamp(right.createdAt) - normalizeTimestamp(left.createdAt))
    .slice(0, 8);
  const trackScores: Record<string, number> = {};
  const artistScores: Record<string, number> = {};
  const tagScores: Record<string, number> = {};

  queries.forEach((entry) => {
    const normalizedQuery = recommendationNormalizationService.normalizeComparisonText(entry.query);
    if (!normalizedQuery) {
      return;
    }

    const queryWeight = recencyWeight(params.now, entry.createdAt, params.config.decay.shortTermHalfLifeMs);
    const queryTimestamp = normalizeTimestamp(entry.createdAt);
    let strongFollowUpMatched = false;

    Object.values(params.snapshot.artistsById).forEach((artist) => {
      const normalizedName = recommendationNormalizationService.normalizeComparisonText(artist.name);
      if (!normalizedName || (!normalizedName.includes(normalizedQuery) && !normalizedQuery.includes(normalizedName))) {
        return;
      }

      const matchedHistory = params.historyEvents.some((historyEvent) => {
        if (!historyEvent.canonicalTrackId || !artist.trackIds.includes(historyEvent.canonicalTrackId)) {
          return false;
        }

        const deltaMs = normalizeTimestamp(historyEvent.createdAt) - queryTimestamp;
        return deltaMs >= 0 && deltaMs <= 30 * 60 * 1000;
      });
      const matchedFavorite = params.favorites.some((favorite) => {
        if (!artist.trackIds.includes(favorite.canonicalTrackId)) {
          return false;
        }

        const deltaMs = normalizeTimestamp(favorite.createdAt) - queryTimestamp;
        return deltaMs >= 0 && deltaMs <= 30 * 60 * 1000;
      });

      const boost = matchedHistory ? 3 : matchedFavorite ? 5 : 1.4;
      strongFollowUpMatched = strongFollowUpMatched || matchedHistory || matchedFavorite;
      addScore(artistScores, artist.canonicalArtistId, boost * queryWeight);
    });

    Object.values(params.snapshot.tagsById).forEach((tag) => {
      const normalizedTag = recommendationNormalizationService.normalizeComparisonText(
        `${tag.displayName} ${tag.slug} ${tag.aliases.join(" ")}`,
      );
      if (!normalizedTag || (!normalizedTag.includes(normalizedQuery) && !normalizedQuery.includes(normalizedTag))) {
        return;
      }

      addScore(tagScores, tag.canonicalTagId, (strongFollowUpMatched ? 2.2 : 1.1) * queryWeight);
    });

    Object.values(params.snapshot.tracksById).forEach((track) => {
      const titleMatch = trackHasQueryMatch(track, normalizedQuery);
      const artistMatch = track.canonicalArtistIds.some((artistId) => {
        const artist = params.snapshot.artistsById[artistId];
        if (!artist) {
          return false;
        }

        const normalizedName = recommendationNormalizationService.normalizeComparisonText(artist.name);
        return normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName);
      });

      if (!titleMatch && !artistMatch) {
        return;
      }

      const matchedHistory = params.historyEvents.some((historyEvent) => {
        if (historyEvent.canonicalTrackId !== track.canonicalTrackId) {
          return false;
        }

        const deltaMs = normalizeTimestamp(historyEvent.createdAt) - queryTimestamp;
        return deltaMs >= 0 && deltaMs <= 30 * 60 * 1000;
      });
      const matchedFavorite = params.favorites.some((favorite) => {
        if (favorite.canonicalTrackId !== track.canonicalTrackId) {
          return false;
        }

        const deltaMs = normalizeTimestamp(favorite.createdAt) - queryTimestamp;
        return deltaMs >= 0 && deltaMs <= 30 * 60 * 1000;
      });
      const boost = matchedFavorite ? 5 : matchedHistory ? 3 : titleMatch ? 1.5 : 1.1;

      strongFollowUpMatched = strongFollowUpMatched || matchedHistory || matchedFavorite;
      addScore(trackScores, track.canonicalTrackId, boost * queryWeight);
    });
  });

  return {
    queries: queries.map((entry) => entry.query),
    trackScores,
    artistScores,
    tagScores,
  } satisfies RecommendationSearchIntentSummary;
}

function buildNegativeSummary(params: {
  profiles: RecommendationProfiles;
  recommendationEvents: UserFeatureRecommendationEvent[];
  config: RecommendationConfig;
  now: number;
}) {
  const hardSuppressedTrackIds = new Set<string>([
    ...params.profiles.entity.dislikedTrackIds,
    ...params.profiles.entity.fastSkippedTrackIds,
    ...params.profiles.entity.dismissedTrackIds,
    ...params.profiles.session.recentDislikedTrackIds,
    ...params.profiles.session.recentFastSkippedTrackIds,
    ...params.profiles.session.recentDismissedTrackIds,
  ]);
  const temporarilyHiddenTrackIds = new Set<string>();
  const fatiguePenaltyByTrackId: Record<string, number> = {};

  Object.entries(params.profiles.entity.exposureFatigueByTrackId).forEach(([trackId, entry]) => {
    const hiddenUntilMs = normalizeTimestamp(entry.hiddenUntil ?? undefined);
    if (hiddenUntilMs && hiddenUntilMs > params.now) {
      temporarilyHiddenTrackIds.add(trackId);
      return;
    }

    if (entry.ignoredCount >= params.config.exposure.fatiguePenaltyThreshold) {
      fatiguePenaltyByTrackId[trackId] = Math.min(
        1,
        (entry.ignoredCount - params.config.exposure.fatiguePenaltyThreshold + 1) / 3,
      );
    }
  });

  params.recommendationEvents.forEach((event) => {
    if (!event.canonicalTrackId || event.eventType !== "INTERACTION") {
      return;
    }

    const action = typeof event.payload?.action === "string" ? event.payload.action : null;
    if (action === "dismiss" || action === "skip") {
      hardSuppressedTrackIds.add(event.canonicalTrackId);
    }
  });

  return {
    hardSuppressedTrackIds: [...hardSuppressedTrackIds].sort((left, right) => left.localeCompare(right)),
    temporarilyHiddenTrackIds: [...temporarilyHiddenTrackIds].sort((left, right) => left.localeCompare(right)),
    fatiguePenaltyByTrackId,
  };
}

function enrichTrackDerivedScores(
  snapshot: RecommendationCatalogSnapshot,
  trackId: string,
  delta: number,
  artistScores: Record<string, number>,
  tagScores: Record<string, number>,
  releaseScores: Record<string, number>,
) {
  const track = snapshot.tracksById[trackId];
  if (!track) {
    return;
  }

  addScore(artistScores, track.primaryCanonicalArtistId ?? undefined, delta * 0.6);
  addScore(releaseScores, track.canonicalReleaseId ?? undefined, delta * 0.25);
  track.tagIds.forEach((tagId) => addScore(tagScores, tagId, delta * 0.22 * (track.tagWeights[tagId] ?? 1)));
}

function isFavoriteTrack(favorites: UserFeatureFavorite[], canonicalTrackId: string) {
  return favorites.some((favorite) => favorite.canonicalTrackId === canonicalTrackId);
}

export function buildUserRecommendationFeatures(params: {
  snapshot: RecommendationCatalogSnapshot;
  profiles: RecommendationProfiles;
  context: RecommendationContext;
  userState: RecommendationUserStateFeaturesInput;
  config: RecommendationConfig;
}) {
  const { snapshot, profiles, context, userState, config } = params;
  const trackScores: Record<string, number> = {};
  const artistScores: Record<string, number> = {};
  const tagScores: Record<string, number> = {};
  const releaseScores: Record<string, number> = {};
  const playlistTrackScores: Record<string, number> = {};
  const sessionTransitionScores: Record<string, number> = {};

  const topTrackSeedIds = new Set<string>();

  Object.entries(profiles.entity.trackAffinities).forEach(([trackId, entry]) => addScore(trackScores, trackId, entry.value * 1.2));
  Object.entries(profiles.entity.artistAffinities).forEach(([artistId, entry]) => addScore(artistScores, artistId, entry.value * 1.1));
  Object.entries(profiles.entity.tagAffinities).forEach(([tagId, entry]) => addScore(tagScores, tagId, entry.value));
  Object.entries(profiles.entity.releaseAffinities).forEach(([releaseId, entry]) =>
    addScore(releaseScores, releaseId, entry.value * 0.8),
  );

  Object.entries(profiles.shortTerm.artistAffinities).forEach(([artistId, entry]) =>
    addScore(artistScores, artistId, entry.value * 1.35),
  );
  Object.entries(profiles.shortTerm.tagAffinities).forEach(([tagId, entry]) => addScore(tagScores, tagId, entry.value * 1.3));
  Object.entries(profiles.shortTerm.releaseAffinities).forEach(([releaseId, entry]) =>
    addScore(releaseScores, releaseId, entry.value),
  );

  Object.entries(profiles.longTerm.artistAffinities).forEach(([artistId, entry]) =>
    addScore(artistScores, artistId, entry.value * 0.75),
  );
  Object.entries(profiles.longTerm.tagAffinities).forEach(([tagId, entry]) => addScore(tagScores, tagId, entry.value * 0.7));
  Object.entries(profiles.longTerm.releaseAffinities).forEach(([releaseId, entry]) =>
    addScore(releaseScores, releaseId, entry.value * 0.65),
  );

  userState.favorites.forEach((favorite) => {
    const weight = 7.5 * recencyWeight(userState.now, favorite.createdAt, config.decay.favoriteHalfLifeMs);
    const track = snapshot.tracksById[favorite.canonicalTrackId];
    // Favorites should anchor taste, but bias more toward genre/style than replaying the same artist forever.
    addScore(trackScores, favorite.canonicalTrackId, weight * 0.16);
    if (track) {
      addScore(artistScores, track.primaryCanonicalArtistId ?? undefined, weight * 0.44);
      addScore(releaseScores, track.canonicalReleaseId ?? undefined, weight * 0.18);
      track.tagIds.forEach((tagId) => addScore(tagScores, tagId, weight * 0.28 * (track.tagWeights[tagId] ?? 1)));
    }
    topTrackSeedIds.add(favorite.canonicalTrackId);
  });

  userState.historyEvents.forEach((event) => {
    const track = snapshot.tracksById[event.canonicalTrackId];
    if (!track) {
      return;
    }

    const recency = recencyWeight(userState.now, event.createdAt, config.decay.shortTermHalfLifeMs);
    const eventType = event.eventType.toUpperCase();
    const weight =
      eventType === "COMPLETED"
        ? 4 * recency
        : eventType === "PROGRESS" || eventType === "STARTED"
          ? 2.25 * recency
          : eventType === "SKIPPED"
            ? -1.75 * recency
            : 1.25 * recency;

    addScore(trackScores, track.canonicalTrackId, weight);
    enrichTrackDerivedScores(snapshot, track.canonicalTrackId, weight, artistScores, tagScores, releaseScores);
    if (weight > 0) {
      topTrackSeedIds.add(track.canonicalTrackId);
    }
  });

  userState.playlists.forEach((playlist) => {
    const uniqueTrackIds = [...new Set(playlist.canonicalTrackIds.filter((trackId) => !!snapshot.tracksById[trackId]))];
    if (!uniqueTrackIds.length) {
      return;
    }

    const playlistWeight = 1 / Math.sqrt(uniqueTrackIds.length);
    const anchorOverlap = uniqueTrackIds.filter((trackId) => topTrackSeedIds.has(trackId)).length;
    const cooccurrenceWeight = playlistWeight * Math.max(0.5, Math.min(3, anchorOverlap || 1));

    uniqueTrackIds.forEach((trackId) => {
      addScore(trackScores, trackId, playlistWeight * (isFavoriteTrack(userState.favorites, trackId) ? 0.9 : 2.5));
      addScore(playlistTrackScores, trackId, cooccurrenceWeight);
      enrichTrackDerivedScores(snapshot, trackId, playlistWeight * 2.5, artistScores, tagScores, releaseScores);
    });
  });

  const orderedHistory = userState.historyEvents
    .slice()
    .sort((left, right) => normalizeTimestamp(left.createdAt) - normalizeTimestamp(right.createdAt));
  for (let index = 0; index < orderedHistory.length - 1; index += 1) {
    const currentEvent = orderedHistory[index];
    const nextEvent = orderedHistory[index + 1];
    if (!currentEvent.canonicalTrackId || !nextEvent.canonicalTrackId || currentEvent.canonicalTrackId === nextEvent.canonicalTrackId) {
      continue;
    }

    const deltaMs = normalizeTimestamp(nextEvent.createdAt) - normalizeTimestamp(currentEvent.createdAt);
    if (deltaMs < 0 || deltaMs > 2 * 60 * 60 * 1000) {
      continue;
    }

    const weight = recencyWeight(userState.now, nextEvent.createdAt, config.decay.sessionHalfLifeMs) * 2.4;
    addScore(sessionTransitionScores, nextEvent.canonicalTrackId, weight);
  }

  profiles.bootstrap.artistIds.forEach((artistId) => addScore(artistScores, artistId, 6));
  profiles.bootstrap.artistNames.forEach((artistName) => {
    const normalizedName = recommendationNormalizationService.normalizeComparisonText(artistName);
    Object.values(snapshot.artistsById).forEach((artist) => {
      const normalizedArtist = recommendationNormalizationService.normalizeComparisonText(artist.name);
      if (
        normalizedName &&
        normalizedArtist &&
        (normalizedArtist.includes(normalizedName) || normalizedName.includes(normalizedArtist))
      ) {
        addScore(artistScores, artist.canonicalArtistId, 6);
      }
    });
  });
  profiles.bootstrap.tagIds.forEach((tagId) => addScore(tagScores, tagId, 4));
  profiles.bootstrap.tags.forEach((tagName) => {
    const normalizedTagName = recommendationNormalizationService.normalizeComparisonText(tagName);
    Object.values(snapshot.tagsById).forEach((tag) => {
      const normalizedTag = recommendationNormalizationService.normalizeComparisonText(
        `${tag.displayName} ${tag.slug} ${tag.aliases.join(" ")}`,
      );
      if (normalizedTag && normalizedTagName && (normalizedTag.includes(normalizedTagName) || normalizedTagName.includes(normalizedTag))) {
        addScore(tagScores, tag.canonicalTagId, 4);
      }
    });
  });

  const searchIntent = buildSearchIntentSummary({
    snapshot,
    favorites: userState.favorites,
    historyEvents: userState.historyEvents,
    searchHistory: userState.searchHistory,
    config,
    now: userState.now,
  });

  Object.entries(searchIntent.trackScores).forEach(([trackId, score]) => addScore(trackScores, trackId, score));
  Object.entries(searchIntent.artistScores).forEach(([artistId, score]) => addScore(artistScores, artistId, score));
  Object.entries(searchIntent.tagScores).forEach(([tagId, score]) => addScore(tagScores, tagId, score));

  const topArtists = toRankedEntries(artistScores, 18);
  const topTags = toRankedEntries(tagScores, 20);
  const topTracks = toRankedEntries(trackScores, 20);
  const topReleases = toRankedEntries(releaseScores, 16);
  const negative = buildNegativeSummary({
    profiles,
    recommendationEvents: userState.recommendationEvents,
    config,
    now: userState.now,
  });

  const hasStrongPersonalSignals =
    userState.favorites.length > 0 ||
    userState.historyEvents.length >= 5 ||
    userState.playlists.some((playlist) => playlist.canonicalTrackIds.length > 0) ||
    topArtists.length >= 3 ||
    topTags.length >= 4;
  const strategy = hasStrongPersonalSignals ? "user-feed" : "cold-start";
  const contextSummary =
    strategy === "cold-start"
      ? "Онбординг вкуса и безопасный discovery по профилю пользователя"
      : "Личный вкус пользователя, история, поисковые намерения и плейлисты";
  return {
    strategy,
    contextSummary,
    favoriteVariantIds: [...new Set(userState.favoriteVariantIds.filter(Boolean))].sort((left, right) =>
      left.localeCompare(right),
    ),
    topArtists,
    topTags,
    topTracks,
    topReleases,
    playlistTrackScores,
    sessionTransitionScores,
    searchIntent,
    negative,
    hasStrongPersonalSignals,
  } satisfies UserRecommendationFeatures;
}

