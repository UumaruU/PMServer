import { RECOMMENDATION_PROFILES_CACHE_KEY } from "../caching/cacheKeys";
import {
  AffinityEntry,
  BootstrapTasteProfile,
  CanonicalTrack,
  DislikeAffinityEvent,
  EntityAffinityProfile,
  ExposureFatigueEntry,
  FavoriteAffinityEvent,
  LongTermTasteProfile,
  PlaybackAffinityEvent,
  PlaylistAffinityEvent,
  RecommendationCacheStore,
  RecommendationCatalogSnapshot,
  RecommendationChannel,
  RecommendationConfig,
  RecommendationDiscoveryLevel,
  RecommendationImpressionEvent,
  RecommendationInteractionEvent,
  RecommendationInteractionAction,
  RecommendationOnboardingProfileInput,
  RecommendationProfiles,
  SessionTasteProfile,
  ShortTermTasteProfile,
} from "../types";

const EPOCH_ISO = new Date(0).toISOString();

function emptyBootstrapTasteProfile(): BootstrapTasteProfile {
  return {
    updatedAt: EPOCH_ISO,
    artistIds: [],
    artistNames: [],
    tagIds: [],
    tags: [],
    languages: [],
    discoveryLevel: "balanced",
  };
}

function emptyShortTermTasteProfile(): ShortTermTasteProfile {
  return {
    updatedAt: EPOCH_ISO,
    artistAffinities: {},
    tagAffinities: {},
    collaboratorAffinities: {},
    releaseAffinities: {},
    flavorAffinities: {},
    languageAffinities: {},
    eraAffinities: {},
  };
}

function emptyLongTermTasteProfile(): LongTermTasteProfile {
  return {
    updatedAt: EPOCH_ISO,
    artistAffinities: {},
    tagAffinities: {},
    collaboratorAffinities: {},
    releaseAffinities: {},
    flavorAffinities: {},
    languageAffinities: {},
    eraAffinities: {},
  };
}

function emptyChannelPenalties(): Record<RecommendationChannel, number> {
  return {
    sameArtist: 0,
    frequentCollaborators: 0,
    relatedArtists: 0,
    sharedTags: 0,
    releaseEraProximity: 0,
    sessionContinuation: 0,
    userAffinityRetrieval: 0,
    userTopArtists: 0,
    userTopTags: 0,
    userTopTracks: 0,
    playlistCooccurrence: 0,
    sessionTransitions: 0,
    searchIntent: 0,
    adjacentDiscovery: 0,
    safeExploration: 0,
  };
}

function emptySessionTasteProfile(): SessionTasteProfile {
  return {
    sessionId: "frontend-local",
    updatedAt: EPOCH_ISO,
    recentTrackIds: [],
    recentArtistIds: [],
    recentTagIds: [],
    recentRecommendationIds: [],
    recentSkippedTrackIds: [],
    recentFastSkippedTrackIds: [],
    recentFavoritedTrackIds: [],
    recentDislikedTrackIds: [],
    recentDismissedTrackIds: [],
    dominantMoodTagId: null,
    dominantGenreTagId: null,
    dominantFlavor: null,
    dominantDurationMs: null,
    channelPenalties: emptyChannelPenalties(),
    replayCountByTrackId: {},
    replayCountByArtistId: {},
  };
}

function emptyAffinityProfile(): EntityAffinityProfile {
  return {
    updatedAt: EPOCH_ISO,
    trackAffinities: {},
    artistAffinities: {},
    tagAffinities: {},
    releaseAffinities: {},
    collaboratorAffinities: {},
    dislikedTrackIds: [],
    fastSkippedTrackIds: [],
    dismissedTrackIds: [],
    exposureFatigueByTrackId: {},
  };
}

export function createEmptyProfiles(): RecommendationProfiles {
  return {
    bootstrap: emptyBootstrapTasteProfile(),
    shortTerm: emptyShortTermTasteProfile(),
    longTerm: emptyLongTermTasteProfile(),
    session: emptySessionTasteProfile(),
    entity: emptyAffinityProfile(),
  };
}

function dedupeStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function dedupeRecentStrings(values: Array<string | null | undefined>) {
  const result: string[] = [];
  values.forEach((value) => {
    const normalized = value?.trim();
    if (!normalized || result.includes(normalized)) {
      return;
    }

    result.push(normalized);
  });

  return result;
}

function decayValue(entry: AffinityEntry | undefined, halfLifeMs: number, nowMs: number) {
  if (!entry) {
    return 0;
  }

  const updatedAt = Date.parse(entry.updatedAt);
  if (!Number.isFinite(updatedAt) || halfLifeMs <= 0) {
    return entry.value;
  }

  const elapsed = Math.max(0, nowMs - updatedAt);
  const decayFactor = Math.pow(0.5, elapsed / halfLifeMs);
  return entry.value * decayFactor;
}

function updateEntry(
  bag: Record<string, AffinityEntry>,
  key: string,
  delta: number,
  nowIso: string,
  halfLifeMs: number,
  nowMs: number,
) {
  const current = bag[key];
  const decayed = decayValue(current, halfLifeMs, nowMs);
  bag[key] = {
    value: decayed + delta,
    updatedAt: nowIso,
    eventCount: (current?.eventCount ?? 0) + 1,
  };
}

function collaboratorKey(leftId: string, rightId: string) {
  return leftId < rightId ? `${leftId}::${rightId}` : `${rightId}::${leftId}`;
}

function pushRecent(list: string[], value: string, limit = 32) {
  return [value, ...list.filter((item) => item !== value)].slice(0, limit);
}

function mergeExposureEntry(existing: Partial<ExposureFatigueEntry> | undefined): ExposureFatigueEntry {
  return {
    impressionCount: existing?.impressionCount ?? 0,
    ignoredCount: existing?.ignoredCount ?? 0,
    dismissedCount: existing?.dismissedCount ?? 0,
    lastImpressionAt: existing?.lastImpressionAt ?? EPOCH_ISO,
    lastPositiveInteractionAt: existing?.lastPositiveInteractionAt ?? null,
    hiddenUntil: existing?.hiddenUntil ?? null,
  };
}

function normalizeProfiles(value: RecommendationProfiles | null | undefined): RecommendationProfiles {
  const empty = createEmptyProfiles();
  const profiles = value ?? empty;

  return {
    bootstrap: {
      ...empty.bootstrap,
      ...profiles.bootstrap,
      artistIds: dedupeStrings(profiles.bootstrap?.artistIds ?? []),
      artistNames: dedupeStrings(profiles.bootstrap?.artistNames ?? []),
      tagIds: dedupeStrings(profiles.bootstrap?.tagIds ?? []),
      tags: dedupeStrings(profiles.bootstrap?.tags ?? []),
      languages: dedupeStrings(profiles.bootstrap?.languages ?? []),
      discoveryLevel: (profiles.bootstrap?.discoveryLevel ?? "balanced") as RecommendationDiscoveryLevel,
    },
    shortTerm: {
      ...empty.shortTerm,
      ...profiles.shortTerm,
      artistAffinities: profiles.shortTerm?.artistAffinities ?? {},
      tagAffinities: profiles.shortTerm?.tagAffinities ?? {},
      collaboratorAffinities: profiles.shortTerm?.collaboratorAffinities ?? {},
      releaseAffinities: profiles.shortTerm?.releaseAffinities ?? {},
      flavorAffinities: profiles.shortTerm?.flavorAffinities ?? {},
      languageAffinities: profiles.shortTerm?.languageAffinities ?? {},
      eraAffinities: profiles.shortTerm?.eraAffinities ?? {},
    },
    longTerm: {
      ...empty.longTerm,
      ...profiles.longTerm,
      artistAffinities: profiles.longTerm?.artistAffinities ?? {},
      tagAffinities: profiles.longTerm?.tagAffinities ?? {},
      collaboratorAffinities: profiles.longTerm?.collaboratorAffinities ?? {},
      releaseAffinities: profiles.longTerm?.releaseAffinities ?? {},
      flavorAffinities: profiles.longTerm?.flavorAffinities ?? {},
      languageAffinities: profiles.longTerm?.languageAffinities ?? {},
      eraAffinities: profiles.longTerm?.eraAffinities ?? {},
    },
    session: {
      ...empty.session,
      ...profiles.session,
      recentTrackIds: dedupeRecentStrings(profiles.session?.recentTrackIds ?? []),
      recentArtistIds: dedupeRecentStrings(profiles.session?.recentArtistIds ?? []),
      recentTagIds: dedupeRecentStrings(profiles.session?.recentTagIds ?? []),
      recentRecommendationIds: dedupeRecentStrings(profiles.session?.recentRecommendationIds ?? []),
      recentSkippedTrackIds: dedupeRecentStrings(profiles.session?.recentSkippedTrackIds ?? []),
      recentFastSkippedTrackIds: dedupeRecentStrings(profiles.session?.recentFastSkippedTrackIds ?? []),
      recentFavoritedTrackIds: dedupeRecentStrings(profiles.session?.recentFavoritedTrackIds ?? []),
      recentDislikedTrackIds: dedupeRecentStrings(profiles.session?.recentDislikedTrackIds ?? []),
      recentDismissedTrackIds: dedupeRecentStrings(profiles.session?.recentDismissedTrackIds ?? []),
      channelPenalties: {
        ...emptyChannelPenalties(),
        ...(profiles.session?.channelPenalties ?? {}),
      },
      replayCountByTrackId: profiles.session?.replayCountByTrackId ?? {},
      replayCountByArtistId: profiles.session?.replayCountByArtistId ?? {},
    },
    entity: {
      ...empty.entity,
      ...profiles.entity,
      trackAffinities: profiles.entity?.trackAffinities ?? {},
      artistAffinities: profiles.entity?.artistAffinities ?? {},
      tagAffinities: profiles.entity?.tagAffinities ?? {},
      releaseAffinities: profiles.entity?.releaseAffinities ?? {},
      collaboratorAffinities: profiles.entity?.collaboratorAffinities ?? {},
      dislikedTrackIds: dedupeStrings(profiles.entity?.dislikedTrackIds ?? []),
      fastSkippedTrackIds: dedupeStrings(profiles.entity?.fastSkippedTrackIds ?? []),
      dismissedTrackIds: dedupeStrings(profiles.entity?.dismissedTrackIds ?? []),
      exposureFatigueByTrackId: Object.fromEntries(
        Object.entries(profiles.entity?.exposureFatigueByTrackId ?? {}).map(([trackId, entry]) => [
          trackId,
          mergeExposureEntry(entry),
        ]),
      ),
    },
  };
}

function updateTrackDerivedAffinities(params: {
  track: CanonicalTrack;
  profiles: RecommendationProfiles;
  deltaTrack: number;
  deltaArtist: number;
  deltaTag: number;
  deltaRelease: number;
  deltaCollaborator: number;
  config: RecommendationConfig;
  occurredAt: string;
}) {
  const { track, profiles, deltaTrack, deltaArtist, deltaTag, deltaRelease, deltaCollaborator, config, occurredAt } =
    params;
  const nowMs = Date.parse(occurredAt);

  updateEntry(
    profiles.entity.trackAffinities,
    track.canonicalTrackId,
    deltaTrack,
    occurredAt,
    config.decay.longTermHalfLifeMs,
    nowMs,
  );

  if (track.primaryCanonicalArtistId) {
    updateEntry(
      profiles.entity.artistAffinities,
      track.primaryCanonicalArtistId,
      deltaArtist,
      occurredAt,
      config.decay.longTermHalfLifeMs,
      nowMs,
    );
    updateEntry(
      profiles.shortTerm.artistAffinities,
      track.primaryCanonicalArtistId,
      deltaArtist,
      occurredAt,
      config.decay.shortTermHalfLifeMs,
      nowMs,
    );
    updateEntry(
      profiles.longTerm.artistAffinities,
      track.primaryCanonicalArtistId,
      deltaArtist,
      occurredAt,
      config.decay.longTermHalfLifeMs,
      nowMs,
    );
  }

  track.tagIds.forEach((tagId) => {
    const weight = track.tagWeights[tagId] ?? 1;
    updateEntry(
      profiles.entity.tagAffinities,
      tagId,
      deltaTag * weight,
      occurredAt,
      config.decay.longTermHalfLifeMs,
      nowMs,
    );
    updateEntry(
      profiles.shortTerm.tagAffinities,
      tagId,
      deltaTag * weight,
      occurredAt,
      config.decay.shortTermHalfLifeMs,
      nowMs,
    );
    updateEntry(
      profiles.longTerm.tagAffinities,
      tagId,
      deltaTag * weight,
      occurredAt,
      config.decay.longTermHalfLifeMs,
      nowMs,
    );
  });

  if (track.canonicalReleaseId) {
    updateEntry(
      profiles.entity.releaseAffinities,
      track.canonicalReleaseId,
      deltaRelease,
      occurredAt,
      config.decay.longTermHalfLifeMs,
      nowMs,
    );
    updateEntry(
      profiles.shortTerm.releaseAffinities,
      track.canonicalReleaseId,
      deltaRelease,
      occurredAt,
      config.decay.shortTermHalfLifeMs,
      nowMs,
    );
    updateEntry(
      profiles.longTerm.releaseAffinities,
      track.canonicalReleaseId,
      deltaRelease,
      occurredAt,
      config.decay.longTermHalfLifeMs,
      nowMs,
    );
  }

  const artistIds = track.canonicalArtistIds;
  for (let index = 0; index < artistIds.length; index += 1) {
    for (let innerIndex = index + 1; innerIndex < artistIds.length; innerIndex += 1) {
      const key = collaboratorKey(artistIds[index], artistIds[innerIndex]);
      updateEntry(
        profiles.entity.collaboratorAffinities,
        key,
        deltaCollaborator,
        occurredAt,
        config.decay.longTermHalfLifeMs,
        nowMs,
      );
      updateEntry(
        profiles.shortTerm.collaboratorAffinities,
        key,
        deltaCollaborator,
        occurredAt,
        config.decay.shortTermHalfLifeMs,
        nowMs,
      );
      updateEntry(
        profiles.longTerm.collaboratorAffinities,
        key,
        deltaCollaborator,
        occurredAt,
        config.decay.longTermHalfLifeMs,
        nowMs,
      );
    }
  }

  const dominantFlavor = track.titleFlavor.find((flavor) => flavor !== "original") ?? track.titleFlavor[0];
  if (dominantFlavor) {
    const flavorDelta = Math.max(deltaTag, deltaArtist * 0.25);
    updateEntry(
      profiles.shortTerm.flavorAffinities,
      dominantFlavor,
      flavorDelta,
      occurredAt,
      config.decay.shortTermHalfLifeMs,
      nowMs,
    );
    updateEntry(
      profiles.longTerm.flavorAffinities,
      dominantFlavor,
      flavorDelta,
      occurredAt,
      config.decay.longTermHalfLifeMs,
      nowMs,
    );
    profiles.session.dominantFlavor = dominantFlavor;
  }

  profiles.session.updatedAt = occurredAt;
  profiles.entity.updatedAt = occurredAt;
  profiles.shortTerm.updatedAt = occurredAt;
  profiles.longTerm.updatedAt = occurredAt;
}

function removeTrackFromNegativeSets(profiles: RecommendationProfiles, canonicalTrackId: string) {
  profiles.entity.dislikedTrackIds = profiles.entity.dislikedTrackIds.filter((trackId) => trackId !== canonicalTrackId);
  profiles.entity.fastSkippedTrackIds = profiles.entity.fastSkippedTrackIds.filter((trackId) => trackId !== canonicalTrackId);
  profiles.entity.dismissedTrackIds = profiles.entity.dismissedTrackIds.filter((trackId) => trackId !== canonicalTrackId);
  profiles.session.recentDislikedTrackIds = profiles.session.recentDislikedTrackIds.filter(
    (trackId) => trackId !== canonicalTrackId,
  );
  profiles.session.recentFastSkippedTrackIds = profiles.session.recentFastSkippedTrackIds.filter(
    (trackId) => trackId !== canonicalTrackId,
  );
  profiles.session.recentDismissedTrackIds = profiles.session.recentDismissedTrackIds.filter(
    (trackId) => trackId !== canonicalTrackId,
  );
}

function markDismissed(profiles: RecommendationProfiles, canonicalTrackId: string) {
  profiles.entity.dismissedTrackIds = pushRecent(profiles.entity.dismissedTrackIds, canonicalTrackId, 256);
  profiles.session.recentDismissedTrackIds = pushRecent(profiles.session.recentDismissedTrackIds, canonicalTrackId, 64);
}

function applyExposureImpression(
  profiles: RecommendationProfiles,
  canonicalTrackId: string,
  occurredAt: string,
  config: RecommendationConfig,
) {
  const exposure = mergeExposureEntry(profiles.entity.exposureFatigueByTrackId[canonicalTrackId]);
  exposure.impressionCount += 1;
  exposure.ignoredCount += 1;
  exposure.lastImpressionAt = occurredAt;
  if (exposure.ignoredCount >= config.exposure.hardHideThreshold) {
    exposure.hiddenUntil = new Date(Date.parse(occurredAt) + config.exposure.fatigueWindowMs).toISOString();
  }

  profiles.entity.exposureFatigueByTrackId[canonicalTrackId] = exposure;
  profiles.entity.updatedAt = occurredAt;
}

function applyExposurePositiveInteraction(
  profiles: RecommendationProfiles,
  canonicalTrackId: string,
  occurredAt: string,
) {
  const exposure = mergeExposureEntry(profiles.entity.exposureFatigueByTrackId[canonicalTrackId]);
  exposure.ignoredCount = 0;
  exposure.hiddenUntil = null;
  exposure.lastPositiveInteractionAt = occurredAt;
  profiles.entity.exposureFatigueByTrackId[canonicalTrackId] = exposure;
  profiles.entity.updatedAt = occurredAt;
}

function trackInteractionDelta(action: RecommendationInteractionAction) {
  switch (action) {
    case "favorite":
      return 8;
    case "playlist_add":
      return 6;
    case "queue":
      return 2;
    case "open":
      return 1;
    default:
      return 0;
  }
}

export async function loadProfiles(cacheStore: RecommendationCacheStore) {
  return normalizeProfiles(await cacheStore.getJson<RecommendationProfiles>(RECOMMENDATION_PROFILES_CACHE_KEY));
}

export async function saveProfiles(cacheStore: RecommendationCacheStore, profiles: RecommendationProfiles) {
  await cacheStore.setJson(RECOMMENDATION_PROFILES_CACHE_KEY, normalizeProfiles(profiles));
}

export async function updateProfilesFromPlayback(params: {
  cacheStore: RecommendationCacheStore;
  snapshot: RecommendationCatalogSnapshot;
  config: RecommendationConfig;
  event: PlaybackAffinityEvent;
}) {
  const profiles = await loadProfiles(params.cacheStore);
  const track = params.snapshot.tracksById[params.event.canonicalTrackId];

  if (!track) {
    return profiles;
  }

  const completionRatio =
    params.event.trackDurationMs > 0 ? params.event.listenedMs / params.event.trackDurationMs : 0;
  const occurredAt = params.event.occurredAt;
  const isFastSkip =
    params.event.wasSkipped &&
    (completionRatio < params.config.completionThresholds.strongNegative || params.event.listenedMs < 30_000);

  profiles.session.sessionId = params.event.sessionId;
  profiles.session.recentTrackIds = pushRecent(profiles.session.recentTrackIds, track.canonicalTrackId, 50);
  if (track.primaryCanonicalArtistId) {
    profiles.session.recentArtistIds = pushRecent(profiles.session.recentArtistIds, track.primaryCanonicalArtistId, 50);
  }
  track.tagIds.forEach((tagId) => {
    profiles.session.recentTagIds = pushRecent(profiles.session.recentTagIds, tagId, 64);
  });
  profiles.session.dominantDurationMs = track.targetDurationMs ?? profiles.session.dominantDurationMs;

  if (completionRatio >= params.config.completionThresholds.veryStrongPositive) {
    removeTrackFromNegativeSets(profiles, track.canonicalTrackId);
    applyExposurePositiveInteraction(profiles, track.canonicalTrackId, occurredAt);
    updateTrackDerivedAffinities({
      track,
      profiles,
      deltaTrack: 4,
      deltaArtist: 3,
      deltaTag: 3,
      deltaRelease: 1,
      deltaCollaborator: 0.5,
      config: params.config,
      occurredAt,
    });
  } else if (completionRatio >= params.config.completionThresholds.strongPositive) {
    removeTrackFromNegativeSets(profiles, track.canonicalTrackId);
    applyExposurePositiveInteraction(profiles, track.canonicalTrackId, occurredAt);
    updateTrackDerivedAffinities({
      track,
      profiles,
      deltaTrack: 4,
      deltaArtist: 2.5,
      deltaTag: 2.5,
      deltaRelease: 1,
      deltaCollaborator: 0.5,
      config: params.config,
      occurredAt,
    });
  } else if (isFastSkip) {
    updateTrackDerivedAffinities({
      track,
      profiles,
      deltaTrack: -6,
      deltaArtist: -3,
      deltaTag: -2,
      deltaRelease: -1,
      deltaCollaborator: -0.5,
      config: params.config,
      occurredAt,
    });
    profiles.entity.fastSkippedTrackIds = pushRecent(profiles.entity.fastSkippedTrackIds, track.canonicalTrackId, 128);
    profiles.session.recentFastSkippedTrackIds = pushRecent(
      profiles.session.recentFastSkippedTrackIds,
      track.canonicalTrackId,
      64,
    );
    profiles.session.recentSkippedTrackIds = pushRecent(profiles.session.recentSkippedTrackIds, track.canonicalTrackId);
    params.event.seedChannels.forEach((channel) => {
      profiles.session.channelPenalties[channel] = (profiles.session.channelPenalties[channel] ?? 0) + 1;
    });
  } else if (completionRatio < params.config.completionThresholds.negative && params.event.wasSkipped) {
    updateTrackDerivedAffinities({
      track,
      profiles,
      deltaTrack: -3,
      deltaArtist: -1.5,
      deltaTag: -1,
      deltaRelease: -0.5,
      deltaCollaborator: -0.25,
      config: params.config,
      occurredAt,
    });
    profiles.session.recentSkippedTrackIds = pushRecent(profiles.session.recentSkippedTrackIds, track.canonicalTrackId);
    params.event.seedChannels.forEach((channel) => {
      profiles.session.channelPenalties[channel] = (profiles.session.channelPenalties[channel] ?? 0) + 0.5;
    });
  }

  const replayCount = (profiles.session.replayCountByTrackId[track.canonicalTrackId] ?? 0) + 1;
  profiles.session.replayCountByTrackId[track.canonicalTrackId] = replayCount;
  if (track.primaryCanonicalArtistId) {
    const artistReplayCount = (profiles.session.replayCountByArtistId[track.primaryCanonicalArtistId] ?? 0) + 1;
    profiles.session.replayCountByArtistId[track.primaryCanonicalArtistId] = artistReplayCount;
  }

  if (replayCount > 1) {
    const replayDelta = Math.min(3, 1 + 2 / (1 + Math.log1p(replayCount)));
    updateTrackDerivedAffinities({
      track,
      profiles,
      deltaTrack: replayDelta,
      deltaArtist: replayDelta * 0.4,
      deltaTag: replayDelta * 0.35,
      deltaRelease: 0,
      deltaCollaborator: 0,
      config: params.config,
      occurredAt,
    });
  }

  await saveProfiles(params.cacheStore, profiles);
  return profiles;
}

export async function updateProfilesFromFavorite(params: {
  cacheStore: RecommendationCacheStore;
  snapshot: RecommendationCatalogSnapshot;
  config: RecommendationConfig;
  event: FavoriteAffinityEvent;
}) {
  const profiles = await loadProfiles(params.cacheStore);
  const track = params.snapshot.tracksById[params.event.canonicalTrackId];
  if (!track) {
    return profiles;
  }

  const direction = params.event.isFavorite ? 1 : -0.6;
  if (params.event.isFavorite) {
    removeTrackFromNegativeSets(profiles, track.canonicalTrackId);
    applyExposurePositiveInteraction(profiles, track.canonicalTrackId, params.event.occurredAt);
  }

  updateTrackDerivedAffinities({
    track,
    profiles,
    deltaTrack: 8 * direction,
    deltaArtist: 5 * direction,
    deltaTag: 4 * direction,
    deltaRelease: 2 * direction,
    deltaCollaborator: 1 * direction,
    config: params.config,
    occurredAt: params.event.occurredAt,
  });

  profiles.session.recentFavoritedTrackIds = params.event.isFavorite
    ? pushRecent(profiles.session.recentFavoritedTrackIds, track.canonicalTrackId)
    : profiles.session.recentFavoritedTrackIds.filter((trackId) => trackId !== track.canonicalTrackId);

  await saveProfiles(params.cacheStore, profiles);
  return profiles;
}

export async function updateProfilesFromPlaylist(params: {
  cacheStore: RecommendationCacheStore;
  snapshot: RecommendationCatalogSnapshot;
  config: RecommendationConfig;
  event: PlaylistAffinityEvent;
}) {
  const profiles = await loadProfiles(params.cacheStore);
  const track = params.snapshot.tracksById[params.event.canonicalTrackId];
  if (!track) {
    return profiles;
  }

  const direction = params.event.isAdded ? 1 : -0.5;
  if (params.event.isAdded) {
    applyExposurePositiveInteraction(profiles, track.canonicalTrackId, params.event.occurredAt);
  }

  updateTrackDerivedAffinities({
    track,
    profiles,
    deltaTrack: params.event.isAdded ? 6 * direction : 6 * direction,
    deltaArtist: 4 * direction,
    deltaTag: 3 * direction,
    deltaRelease: 1.5 * direction,
    deltaCollaborator: 0.5 * direction,
    config: params.config,
    occurredAt: params.event.occurredAt,
  });
  await saveProfiles(params.cacheStore, profiles);
  return profiles;
}

export async function updateProfilesFromDislike(params: {
  cacheStore: RecommendationCacheStore;
  snapshot: RecommendationCatalogSnapshot;
  config: RecommendationConfig;
  event: DislikeAffinityEvent;
}) {
  const profiles = await loadProfiles(params.cacheStore);
  const track = params.snapshot.tracksById[params.event.canonicalTrackId];
  if (!track) {
    return profiles;
  }

  const direction = params.event.isDisliked ? -1 : 0.5;
  updateTrackDerivedAffinities({
    track,
    profiles,
    deltaTrack: 10 * direction,
    deltaArtist: 4 * direction,
    deltaTag: 4 * direction,
    deltaRelease: 2 * direction,
    deltaCollaborator: 0.5 * direction,
    config: params.config,
    occurredAt: params.event.occurredAt,
  });

  if (params.event.isDisliked) {
    profiles.entity.dislikedTrackIds = pushRecent(profiles.entity.dislikedTrackIds, track.canonicalTrackId, 128);
    profiles.session.recentDislikedTrackIds = pushRecent(profiles.session.recentDislikedTrackIds, track.canonicalTrackId);
  } else {
    removeTrackFromNegativeSets(profiles, track.canonicalTrackId);
  }

  await saveProfiles(params.cacheStore, profiles);
  return profiles;
}

export async function updateBootstrapProfile(params: {
  cacheStore: RecommendationCacheStore;
  input: RecommendationOnboardingProfileInput;
}) {
  const profiles = await loadProfiles(params.cacheStore);
  profiles.bootstrap = {
    ...profiles.bootstrap,
    artistIds: dedupeStrings(params.input.artistIds ?? profiles.bootstrap.artistIds),
    artistNames: dedupeStrings(params.input.artistNames ?? profiles.bootstrap.artistNames),
    tagIds: dedupeStrings(params.input.tags ?? profiles.bootstrap.tagIds),
    tags: dedupeStrings(params.input.tags ?? profiles.bootstrap.tags),
    languages: dedupeStrings(params.input.languages ?? profiles.bootstrap.languages),
    discoveryLevel: params.input.discoveryLevel ?? profiles.bootstrap.discoveryLevel ?? "balanced",
    updatedAt: new Date().toISOString(),
  };
  await saveProfiles(params.cacheStore, profiles);
  return profiles;
}

export async function updateProfilesFromImpressions(params: {
  cacheStore: RecommendationCacheStore;
  config: RecommendationConfig;
  events: RecommendationImpressionEvent[];
}) {
  const profiles = await loadProfiles(params.cacheStore);
  params.events.forEach((event) => {
    applyExposureImpression(profiles, event.canonicalTrackId, event.occurredAt, params.config);
  });
  if (params.events.length) {
    profiles.session.updatedAt = params.events[params.events.length - 1].occurredAt;
  }
  await saveProfiles(params.cacheStore, profiles);
  return profiles;
}

export async function updateProfilesFromInteraction(params: {
  cacheStore: RecommendationCacheStore;
  snapshot: RecommendationCatalogSnapshot;
  config: RecommendationConfig;
  event: RecommendationInteractionEvent;
}) {
  const profiles = await loadProfiles(params.cacheStore);
  const track = params.snapshot.tracksById[params.event.canonicalTrackId];
  if (!track) {
    return profiles;
  }

  const occurredAt = params.event.occurredAt;
  switch (params.event.action) {
    case "dismiss":
      markDismissed(profiles, track.canonicalTrackId);
      {
        const exposure = mergeExposureEntry(profiles.entity.exposureFatigueByTrackId[track.canonicalTrackId]);
        exposure.dismissedCount += 1;
        exposure.hiddenUntil = new Date(Date.parse(occurredAt) + params.config.exposure.fatigueWindowMs).toISOString();
        profiles.entity.exposureFatigueByTrackId[track.canonicalTrackId] = exposure;
      }
      updateTrackDerivedAffinities({
        track,
        profiles,
        deltaTrack: -4,
        deltaArtist: -2,
        deltaTag: -1,
        deltaRelease: -1,
        deltaCollaborator: -0.25,
        config: params.config,
        occurredAt,
      });
      break;
    case "skip":
      await saveProfiles(
        params.cacheStore,
        await updateProfilesFromPlayback({
          cacheStore: params.cacheStore,
          snapshot: params.snapshot,
          config: params.config,
          event: {
            canonicalTrackId: params.event.canonicalTrackId,
            listenedMs: params.event.listenedMs ?? 0,
            trackDurationMs: params.event.trackDurationMs ?? 0,
            occurredAt,
            endedNaturally: false,
            wasSkipped: true,
            sessionId: profiles.session.sessionId,
            seedChannels: ["userAffinityRetrieval"],
          },
        }),
      );
      return loadProfiles(params.cacheStore);
    case "play":
      if (typeof params.event.listenedMs === "number" && typeof params.event.trackDurationMs === "number") {
        await saveProfiles(
          params.cacheStore,
          await updateProfilesFromPlayback({
            cacheStore: params.cacheStore,
            snapshot: params.snapshot,
            config: params.config,
            event: {
              canonicalTrackId: params.event.canonicalTrackId,
              listenedMs: params.event.listenedMs,
              trackDurationMs: params.event.trackDurationMs,
              occurredAt,
              endedNaturally: (params.event.listenedMs ?? 0) >= (params.event.trackDurationMs ?? 0),
              wasSkipped: false,
              sessionId: profiles.session.sessionId,
              seedChannels: ["userAffinityRetrieval"],
            },
          }),
        );
        return loadProfiles(params.cacheStore);
      }
      applyExposurePositiveInteraction(profiles, track.canonicalTrackId, occurredAt);
      updateTrackDerivedAffinities({
        track,
        profiles,
        deltaTrack: 3,
        deltaArtist: 1.5,
        deltaTag: 1,
        deltaRelease: 0.5,
        deltaCollaborator: 0.15,
        config: params.config,
        occurredAt,
      });
      break;
    case "favorite":
    case "playlist_add":
    case "queue":
    case "open":
      applyExposurePositiveInteraction(profiles, track.canonicalTrackId, occurredAt);
      removeTrackFromNegativeSets(profiles, track.canonicalTrackId);
      {
        const delta = trackInteractionDelta(params.event.action);
        updateTrackDerivedAffinities({
          track,
          profiles,
          deltaTrack: delta,
          deltaArtist: delta * 0.55,
          deltaTag: delta * 0.45,
          deltaRelease: delta * 0.2,
          deltaCollaborator: delta * 0.08,
          config: params.config,
          occurredAt,
        });
      }
      break;
  }

  await saveProfiles(params.cacheStore, profiles);
  return profiles;
}
