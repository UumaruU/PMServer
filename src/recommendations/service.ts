import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient, type RecommendationEventType, type Track } from "@prisma/client";

import { createRecommendationEngine } from "../recommendation";
import {
  loadProfiles,
  updateBootstrapProfile,
  updateProfilesFromImpressions,
  updateProfilesFromInteraction,
} from "../recommendation/affinity/profileStore";
import {
  RECOMMENDATION_LAST_ARTIST_RANKING_KEY,
  RECOMMENDATION_LAST_TRACK_RANKING_KEY,
  RECOMMENDATION_LAST_TRACK_RESULT_KEY,
  RECOMMENDATION_PENDING_WAVE_NEXT_KEY,
  RECOMMENDATION_PROFILES_CACHE_KEY,
  RECOMMENDATION_USER_FEATURES_CACHE_KEY,
} from "../recommendation/caching/cacheKeys";
import { buildRecommendationCatalogSnapshot } from "../recommendation/canonical-graph/snapshotBuilder";
import { defaultRecommendationConfig } from "../recommendation/config/defaultRecommendationConfig";
import { buildUserRecommendationFeatures } from "../recommendation/user-features/buildUserRecommendationFeatures";
import type {
  DislikeAffinityEvent,
  FavoriteAffinityEvent,
  PlaybackAffinityEvent,
  PlaylistAffinityEvent,
  RecommendationCatalogSnapshot,
  RecommendationChannel,
  RecommendationContext,
  RecommendationImpressionEvent,
  RecommendationInteractionAction,
  RecommendationInteractionEvent,
  RecommendationMode,
  RecommendationOnboardingProfileInput,
  RecommendationProfiles,
  RecommendationSeed,
  RecommendationSourceProviderMetadata,
  RecommendationSourceTrack,
  RecommendedArtist,
  RecommendedTrack,
  UserRecommendationFeatures,
} from "../recommendation/types";
import { serializeTrackForClient } from "../tracks/serializers";
import { ensureSyncTrack, ensureSyncTracks, toExternalTrackId } from "../tracks/service";

const NON_PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const PROVIDER_METADATA: Record<string, RecommendationSourceProviderMetadata> = {
  musicbrainz: {
    providerId: "musicbrainz",
    sourcePriority: 100,
    sourceTrustScore: 1,
    popularityPrior: 0.2,
  },
  soundcloud: {
    providerId: "soundcloud",
    sourcePriority: 50,
    sourceTrustScore: 0.55,
    popularityPrior: 0.2,
  },
  lmusic: {
    providerId: "lmusic",
    sourcePriority: 35,
    sourceTrustScore: 0.35,
    popularityPrior: 0.15,
  },
  hitmos: {
    providerId: "hitmos",
    sourcePriority: 34,
    sourceTrustScore: 0.35,
    popularityPrior: 0.15,
  },
  telegram: {
    providerId: "telegram",
    sourcePriority: 10,
    sourceTrustScore: 0.45,
    popularityPrior: 0.05,
  },
  "client-sync": {
    providerId: "client-sync",
    sourcePriority: 5,
    sourceTrustScore: 0.15,
    popularityPrior: 0.05,
  },
};

type UserStateRecord = Awaited<ReturnType<typeof getUserState>>;
type RequestContext = Awaited<ReturnType<typeof createRequestContext>>;
type ResolvedRecommendedTrack = NonNullable<ReturnType<typeof resolveRecommendedTrack>>;

interface PendingWavePayload {
  mode: RecommendationMode;
  basisCurrentCanonicalTrackId: string | null;
  basisRecentRecommendationIds: string[];
  requestId: string;
  strategy: string;
  contextSummary: string;
  seedLabel: string;
  item: ResolvedRecommendedTrack;
}

let catalogSnapshotCache:
  | {
      revision: string;
      snapshot: RecommendationCatalogSnapshot;
      trackByClientId: Map<string, Track>;
    }
  | null = null;

function dedupe(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeTimestamp(value: string | Date | null | undefined) {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function getProviderId(track: Track) {
  const externalTrackId = toExternalTrackId(track);
  if (externalTrackId.includes(":")) {
    return externalTrackId.slice(0, externalTrackId.indexOf(":")) || track.source || "hitmos";
  }

  return track.source === "client-sync" ? "hitmos" : track.source;
}

function getProviderTrackId(track: Track) {
  const externalTrackId = toExternalTrackId(track);
  if (externalTrackId.includes(":")) {
    return externalTrackId.slice(externalTrackId.indexOf(":") + 1) || track.sourceTrackId;
  }

  return track.sourceTrackId;
}

function toRecommendationSourceTrack(track: Track, favoriteTrackIds = new Set<string>()): RecommendationSourceTrack {
  const providerId = getProviderId(track);

  return {
    id: toExternalTrackId(track),
    providerId,
    providerTrackId: getProviderTrackId(track),
    title: track.title,
    artist: track.artistName,
    coverUrl: track.coverUrl ?? "",
    audioUrl: track.audioUrl ?? "",
    duration: track.duration ?? 0,
    sourceUrl:
      providerId === "hitmos"
        ? "https://rus.hitmotop.com"
        : track.audioUrl ?? `https://example.invalid/tracks/${encodeURIComponent(track.sourceTrackId)}`,
    isFavorite: favoriteTrackIds.has(track.id),
    metadataStatus: track.musicBrainzRecordingId || track.musicBrainzArtistId || track.musicBrainzReleaseId ? "enriched" : "raw",
    albumTitle: track.albumTitle ?? undefined,
    musicBrainzRecordingId: track.musicBrainzRecordingId ?? null,
    musicBrainzArtistId: track.musicBrainzArtistId ?? null,
    musicBrainzReleaseId: track.musicBrainzReleaseId ?? null,
    sourcePriority: PROVIDER_METADATA[providerId]?.sourcePriority,
    sourceTrustScore: PROVIDER_METADATA[providerId]?.sourceTrustScore,
  };
}

function mapTrackIdsToCanonicalIds(snapshot: RecommendationCatalogSnapshot, trackIds: string[]) {
  return dedupe(
    trackIds
      .map((trackId) => snapshot.tracksById[trackId]?.canonicalTrackId ?? snapshot.canonicalIdByVariantTrackId[trackId])
      .filter((trackId): trackId is string => !!trackId),
  );
}

function buildRecentTagCloud(snapshot: RecommendationCatalogSnapshot, canonicalTrackIds: string[]) {
  return canonicalTrackIds.reduce<Record<string, number>>((cloud, canonicalTrackId) => {
    const track = snapshot.tracksById[canonicalTrackId];
    if (!track) {
      return cloud;
    }

    track.tagIds.forEach((tagId) => {
      cloud[tagId] = (cloud[tagId] ?? 0) + (track.tagWeights[tagId] ?? 1);
    });

    return cloud;
  }, {});
}

function buildCanonicalArtistLabel(snapshot: RecommendationCatalogSnapshot, canonicalTrackId: string | null | undefined) {
  if (!canonicalTrackId) {
    return "";
  }

  const track = snapshot.tracksById[canonicalTrackId];
  if (!track) {
    return "";
  }

  return track.canonicalArtistIds
    .map((artistId) => snapshot.artistsById[artistId]?.name ?? "")
    .filter(Boolean)
    .join(", ");
}

function buildSeedLabel(snapshot: RecommendationCatalogSnapshot, canonicalTrackId: string | null) {
  if (!canonicalTrackId) {
    return "вашему вкусу";
  }

  const track = snapshot.tracksById[canonicalTrackId];
  if (!track) {
    return "вашему вкусу";
  }

  const artistLabel = buildCanonicalArtistLabel(snapshot, canonicalTrackId);
  return artistLabel ? `${track.title} • ${artistLabel}` : track.title;
}

function buildDefaultContextSummary(context: RecommendationContext) {
  void context;
  return "Personal wave from user taste";
}

function pickFirstWaveCandidate(
  ranking: RecommendedTrack[],
  context: RecommendationContext,
  snapshot: RecommendationCatalogSnapshot,
) {
  if (!ranking.length) {
    return null;
  }

  const nonFavoriteCandidate = ranking.find((candidate) => {
    const track = snapshot.tracksById[candidate.canonicalTrackId];
    if (!track) {
      return false;
    }

    const isExactFavorite =
      context.favoritedTrackIds.includes(candidate.canonicalTrackId) ||
      (!!track.preferredVariantId && !!context.userFeatures?.favoriteVariantIds.includes(track.preferredVariantId));

    return !isExactFavorite;
  });

  return nonFavoriteCandidate ?? ranking[0];
}

async function clearPendingWave(cacheStore: Awaited<ReturnType<typeof createCacheStore>>) {
  await cacheStore.remove(RECOMMENDATION_PENDING_WAVE_NEXT_KEY);
}

async function getPendingWave(
  cacheStore: Awaited<ReturnType<typeof createCacheStore>>,
): Promise<PendingWavePayload | null> {
  return cacheStore.getJson<PendingWavePayload>(RECOMMENDATION_PENDING_WAVE_NEXT_KEY);
}

async function setPendingWave(
  cacheStore: Awaited<ReturnType<typeof createCacheStore>>,
  payload: PendingWavePayload,
) {
  await cacheStore.setJson(RECOMMENDATION_PENDING_WAVE_NEXT_KEY, payload);
}

function buildUserStateSignature(userState: UserStateRecord) {
  const playlistRevision = userState.playlists
    .map((playlist) => playlist.updatedAt.getTime())
    .sort((left, right) => right - left)[0];
  const searchRevision = userState.searchHistoryEntries[0]?.updatedAt.getTime() ?? 0;
  const eventRevision = userState.recommendationEvents[0]?.createdAt.getTime() ?? 0;

  return [
    userState.profileRevision,
    userState.favorites.length,
    userState.favorites[0]?.createdAt.getTime() ?? 0,
    userState.historyEvents.length,
    userState.historyEvents[0]?.createdAt.getTime() ?? 0,
    userState.playlists.length,
    playlistRevision ?? 0,
    userState.searchHistoryEntries.length,
    searchRevision,
    userState.recommendationEvents.length,
    eventRevision,
  ].join(":");
}

function buildBaseContext(params: {
  snapshot: RecommendationCatalogSnapshot;
  favoriteClientTrackIds: string[];
  historyClientTrackIds: string[];
  sessionRecentTrackIds?: string[];
  mode: RecommendationMode;
  currentTrackId?: string | null;
  recentRecommendationTrackIds?: string[];
  skippedTrackIds?: string[];
  userFeatures?: UserRecommendationFeatures;
}) {
  const compactRecentSequence = (trackIds: string[], limit = 24) => {
    const result: string[] = [];

    trackIds.forEach((trackId) => {
      if (!trackId) {
        return;
      }

      if (result[result.length - 1] === trackId) {
        return;
      }

      result.push(trackId);
    });

    return result.slice(0, limit);
  };

  const favoriteCanonicalTrackIds = mapTrackIdsToCanonicalIds(params.snapshot, params.favoriteClientTrackIds);
  const historyCanonicalTrackIds = mapTrackIdsToCanonicalIds(params.snapshot, params.historyClientTrackIds);
  const currentCanonicalTrackId = params.currentTrackId
    ? params.snapshot.canonicalIdByVariantTrackId[params.currentTrackId] ?? null
    : null;
  const currentTrack = currentCanonicalTrackId
    ? params.snapshot.tracksById[currentCanonicalTrackId] ?? null
    : null;

  const recentPlaybackTrackIds = compactRecentSequence(
    params.sessionRecentTrackIds?.length
      ? params.sessionRecentTrackIds
      : historyCanonicalTrackIds,
  );
  const tagCloudTrackIds = dedupe([...recentPlaybackTrackIds, ...favoriteCanonicalTrackIds]).slice(0, 64);

  return {
    mode: params.mode,
    currentCanonicalTrackId,
    currentPrimaryArtistId: null,
    playbackPrimaryArtistId: currentTrack?.primaryCanonicalArtistId ?? null,
    currentFeaturedArtistIds: [],
    currentTrackTagIds: [],
    currentArtistTagIds: [],
    currentReleaseId: null,
    currentFlavor: null,
    currentDurationMs: null,
    recentTrackIds: recentPlaybackTrackIds,
    recentArtistIds: recentPlaybackTrackIds
      .map((trackId) => params.snapshot.tracksById[trackId]?.primaryCanonicalArtistId ?? "")
      .filter(Boolean),
    recentTagCloud: buildRecentTagCloud(params.snapshot, tagCloudTrackIds),
    recentRecommendationIds: mapTrackIdsToCanonicalIds(params.snapshot, params.recentRecommendationTrackIds ?? []),
    skippedTrackIds: mapTrackIdsToCanonicalIds(params.snapshot, params.skippedTrackIds ?? []),
    favoritedTrackIds: favoriteCanonicalTrackIds,
    userFeatures: params.userFeatures,
  } satisfies RecommendationContext;
}

async function createCacheStore(prisma: PrismaClient, userId: string) {
  return {
    async getJson<T>(key: string): Promise<T | null> {
      if (key === RECOMMENDATION_PROFILES_CACHE_KEY) {
        const profile = await prisma.userRecommendationProfile.findUnique({
          where: {
            userId,
          },
        });

        if (!profile) {
          return null;
        }

        return {
          bootstrap: profile.bootstrapProfile,
          shortTerm: profile.shortTermProfile,
          longTerm: profile.longTermProfile,
          session: profile.sessionProfile,
          entity: profile.entityProfile,
        } as T;
      }

      const entry = await prisma.userRecommendationCacheEntry.findUnique({
        where: {
          userId_cacheKey: {
            userId,
            cacheKey: key,
          },
        },
      });

      if (!entry) {
        return null;
      }

      if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) {
        await prisma.userRecommendationCacheEntry.delete({
          where: {
            userId_cacheKey: {
              userId,
              cacheKey: key,
            },
          },
        });
        return null;
      }

      return (entry.payload as T | undefined) ?? null;
    },

    async setJson<T>(key: string, value: T) {
      if (key === RECOMMENDATION_PROFILES_CACHE_KEY) {
        const profiles = value as RecommendationProfiles;
        await prisma.userRecommendationProfile.upsert({
          where: {
            userId,
          },
          create: {
            userId,
            bootstrapProfile: profiles.bootstrap as unknown as Prisma.InputJsonValue,
            shortTermProfile: profiles.shortTerm as unknown as Prisma.InputJsonValue,
            longTermProfile: profiles.longTerm as unknown as Prisma.InputJsonValue,
            sessionProfile: profiles.session as unknown as Prisma.InputJsonValue,
            entityProfile: profiles.entity as unknown as Prisma.InputJsonValue,
          },
          update: {
            bootstrapProfile: profiles.bootstrap as unknown as Prisma.InputJsonValue,
            shortTermProfile: profiles.shortTerm as unknown as Prisma.InputJsonValue,
            longTermProfile: profiles.longTerm as unknown as Prisma.InputJsonValue,
            sessionProfile: profiles.session as unknown as Prisma.InputJsonValue,
            entityProfile: profiles.entity as unknown as Prisma.InputJsonValue,
            profileRevision: {
              increment: 1,
            },
          },
        });
        return;
      }

      await prisma.userRecommendationCacheEntry.upsert({
        where: {
          userId_cacheKey: {
            userId,
            cacheKey: key,
          },
        },
        create: {
          userId,
          cacheKey: key,
          payload: value as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + NON_PROFILE_CACHE_TTL_MS),
        },
        update: {
          payload: value as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + NON_PROFILE_CACHE_TTL_MS),
        },
      });
    },

    async remove(key: string) {
      if (key === RECOMMENDATION_PROFILES_CACHE_KEY) {
        await prisma.userRecommendationProfile.deleteMany({
          where: {
            userId,
          },
        });
        return;
      }

      await prisma.userRecommendationCacheEntry.deleteMany({
        where: {
          userId,
          cacheKey: key,
        },
      });
    },
  };
}

function createResultWriter(prisma: PrismaClient, userId: string) {
  const write = async (key: string, value: unknown) => {
    await prisma.userRecommendationCacheEntry.upsert({
      where: {
        userId_cacheKey: {
          userId,
          cacheKey: key,
        },
      },
      create: {
        userId,
        cacheKey: key,
        payload: value as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + NON_PROFILE_CACHE_TTL_MS),
      },
      update: {
        payload: value as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + NON_PROFILE_CACHE_TTL_MS),
      },
    });
  };

  return {
    async writeTrackResult(input: { context: RecommendationContext; result: RecommendedTrack | null }) {
      await write(RECOMMENDATION_LAST_TRACK_RESULT_KEY, input);
    },
    async writeTrackRanking(input: {
      seed: RecommendationSeed;
      context: RecommendationContext;
      results: RecommendedTrack[];
    }) {
      await write(RECOMMENDATION_LAST_TRACK_RANKING_KEY, input);
    },
    async writeArtistRanking(input: {
      seed: RecommendationSeed;
      context: RecommendationContext;
      results: RecommendedArtist[];
    }) {
      await write(RECOMMENDATION_LAST_ARTIST_RANKING_KEY, input);
    },
  };
}

async function getCatalogSnapshotRevision(prisma: PrismaClient) {
  const summary = await prisma.track.aggregate({
    _count: {
      _all: true,
    },
    _max: {
      updatedAt: true,
    },
  });

  return `${summary._count._all}:${summary._max.updatedAt?.toISOString() ?? "none"}`;
}

async function buildCatalogSnapshot(prisma: PrismaClient) {
  const revision = await getCatalogSnapshotRevision(prisma);
  if (catalogSnapshotCache?.revision === revision) {
    return catalogSnapshotCache;
  }

  const tracks = await prisma.track.findMany({
    orderBy: [
      {
        updatedAt: "desc",
      },
      {
        id: "asc",
      },
    ],
  });
  const trackByClientId = new Map(tracks.map((track) => [toExternalTrackId(track), track] as const));
  const snapshot = buildRecommendationCatalogSnapshot({
    tracks: tracks.map((track) => toRecommendationSourceTrack(track)),
    artists: [],
    releases: [],
    providerMetadata: PROVIDER_METADATA,
    config: defaultRecommendationConfig,
  });

  catalogSnapshotCache = {
    revision,
    snapshot,
    trackByClientId,
  };

  return catalogSnapshotCache;
}

async function getUserState(prisma: PrismaClient, userId: string) {
  const [favorites, historyEvents, playlists, searchHistoryEntries, recommendationEvents, profile] = await Promise.all([
    prisma.favorite.findMany({
      where: {
        userId,
      },
      include: {
        track: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.userHistoryEvent.findMany({
      where: {
        userId,
      },
      include: {
        track: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 120,
    }),
    prisma.playlist.findMany({
      where: {
        userId,
      },
      include: {
        tracks: {
          include: {
            track: true,
          },
          orderBy: {
            position: "asc",
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    }),
    prisma.userSearchHistoryEntry.findMany({
      where: {
        userId,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 24,
    }),
    prisma.userRecommendationEvent.findMany({
      where: {
        userId,
      },
      include: {
        track: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 200,
    }),
    prisma.userRecommendationProfile.findUnique({
      where: {
        userId,
      },
      select: {
        profileRevision: true,
      },
    }),
  ]);

  return {
    favorites,
    historyEvents,
    playlists,
    searchHistoryEntries,
    recommendationEvents,
    profileRevision: profile?.profileRevision ?? 0,
  };
}

async function getOrBuildUserFeatures(params: {
  cacheStore: Awaited<ReturnType<typeof createCacheStore>>;
  snapshot: RecommendationCatalogSnapshot;
  baseContext: RecommendationContext;
  userState: UserStateRecord;
  favoriteClientTrackIds: string[];
  profiles: RecommendationProfiles;
}) {
  const signature = [
    params.snapshot.snapshotRevision,
    buildUserStateSignature(params.userState),
    params.baseContext.currentCanonicalTrackId ?? "",
    params.baseContext.mode,
  ].join("|");
  const cached = await params.cacheStore.getJson<{ signature: string; features: UserRecommendationFeatures }>(
    RECOMMENDATION_USER_FEATURES_CACHE_KEY,
  );
  if (cached?.signature === signature) {
    return cached.features;
  }

  const favorites = params.userState.favorites
    .map((favorite) => ({
      canonicalTrackId:
        params.snapshot.canonicalIdByVariantTrackId[toExternalTrackId(favorite.track)] ??
        params.snapshot.tracksById[toExternalTrackId(favorite.track)]?.canonicalTrackId,
      createdAt: favorite.createdAt.toISOString(),
    }))
    .filter((favorite): favorite is { canonicalTrackId: string; createdAt: string } => !!favorite.canonicalTrackId);
  const historyEvents = params.userState.historyEvents
    .map((event) => ({
      canonicalTrackId:
        params.snapshot.canonicalIdByVariantTrackId[toExternalTrackId(event.track)] ??
        params.snapshot.tracksById[toExternalTrackId(event.track)]?.canonicalTrackId,
      createdAt: event.createdAt.toISOString(),
      eventType: event.eventType,
      playedMs: event.playedMs,
    }))
    .filter(
      (
        event,
      ): event is {
        canonicalTrackId: string;
        createdAt: string;
        eventType: UserStateRecord["historyEvents"][number]["eventType"];
        playedMs: number | null;
      } => !!event.canonicalTrackId,
    );
  const playlists = params.userState.playlists.map((playlist) => ({
    id: playlist.id,
    canonicalTrackIds: playlist.tracks
      .map((item) => params.snapshot.canonicalIdByVariantTrackId[toExternalTrackId(item.track)] ?? "")
      .filter(Boolean),
    createdAt: normalizeTimestamp(playlist.createdAt),
    updatedAt: normalizeTimestamp(playlist.updatedAt),
  }));
  const searchHistory = params.userState.searchHistoryEntries.map((entry) => ({
    query: entry.query,
    createdAt: entry.createdAt.toISOString(),
  }));
  const recommendationEvents = params.userState.recommendationEvents.map((event) => {
    const payload = (event.payload as Record<string, unknown> | null | undefined) ?? null;
    const rawTrackId = event.track ? toExternalTrackId(event.track) : typeof payload?.trackId === "string" ? payload.trackId : null;
    return {
      eventType: event.eventType,
      canonicalTrackId: rawTrackId ? params.snapshot.canonicalIdByVariantTrackId[rawTrackId] ?? null : null,
      payload,
      createdAt: event.createdAt.toISOString(),
    };
  });

  const features = buildUserRecommendationFeatures({
    snapshot: params.snapshot,
    profiles: params.profiles,
    context: params.baseContext,
    userState: {
      favorites,
      historyEvents,
      playlists,
      searchHistory,
      recommendationEvents,
      favoriteVariantIds: params.favoriteClientTrackIds,
      now: Date.now(),
    },
    config: defaultRecommendationConfig,
  });

  await params.cacheStore.setJson(RECOMMENDATION_USER_FEATURES_CACHE_KEY, {
    signature,
    features,
  });
  return features;
}

async function createRequestContext(prisma: PrismaClient, userId: string) {
  const [userState, cacheStore, catalog] = await Promise.all([
    getUserState(prisma, userId),
    createCacheStore(prisma, userId),
    buildCatalogSnapshot(prisma),
  ]);
  const favoriteClientTrackIds = userState.favorites.map((favorite) => toExternalTrackId(favorite.track));
  const historyClientTrackIds = userState.historyEvents.map((event) => toExternalTrackId(event.track));
  const playlists = userState.playlists.map((playlist) => ({
    id: playlist.id,
    trackIds: playlist.tracks.map((item) => toExternalTrackId(item.track)),
    createdAt: playlist.createdAt.toISOString(),
    updatedAt: playlist.updatedAt.toISOString(),
  }));
  const profiles = await loadProfiles(cacheStore);
  const engine = createRecommendationEngine(
    {
      catalogReader: {
        async getSnapshot() {
          return catalog.snapshot;
        },
      },
      userHistoryReader: {
        async getRecentHistory() {
          return userState.historyEvents.map((entry) => ({
            trackId: catalog.snapshot.canonicalIdByVariantTrackId[toExternalTrackId(entry.track)] ?? toExternalTrackId(entry.track),
            listenedAt: entry.createdAt.toISOString(),
          }));
        },
      },
      favoritesReader: {
        async getFavoriteTrackIds() {
          return mapTrackIdsToCanonicalIds(catalog.snapshot, favoriteClientTrackIds);
        },
      },
      playlistsReader: {
        async getPlaylists() {
          return playlists;
        },
      },
      playableVariantReader: {
        async getPlayableVariantIds(canonicalTrackId) {
          return catalog.snapshot.playableVariantsByCanonicalTrackId[canonicalTrackId] ?? [];
        },
        async resolvePreferredVariantId(canonicalTrackId) {
          return catalog.snapshot.tracksById[canonicalTrackId]?.preferredVariantId ?? null;
        },
      },
      providerMetadataReader: {
        async getProviderMetadata() {
          return PROVIDER_METADATA;
        },
      },
      cacheStore,
      resultWriter: createResultWriter(prisma, userId),
      clock: {
        now() {
          return Date.now();
        },
      },
    },
    defaultRecommendationConfig,
  );

  return {
    engine,
    snapshot: catalog.snapshot,
    trackByClientId: catalog.trackByClientId,
    userState,
    profiles,
    favoriteClientTrackIds,
    historyClientTrackIds,
    playlists,
    cacheStore,
  };
}

async function buildRecommendationContext(
  requestContext: RequestContext,
  input: {
    currentTrackId?: string | null;
    recentRecommendationTrackIds?: string[];
    skippedTrackIds?: string[];
    mode?: RecommendationMode;
  },
) {
  const baseContext = buildBaseContext({
    snapshot: requestContext.snapshot,
    favoriteClientTrackIds: requestContext.favoriteClientTrackIds,
    historyClientTrackIds: requestContext.historyClientTrackIds,
    sessionRecentTrackIds: requestContext.profiles.session.recentTrackIds,
    currentTrackId: input.currentTrackId ?? null,
    recentRecommendationTrackIds: input.recentRecommendationTrackIds ?? [],
    skippedTrackIds: input.skippedTrackIds ?? [],
    mode: input.mode ?? "autoplay",
  });
  const userFeatures = await getOrBuildUserFeatures({
    cacheStore: requestContext.cacheStore,
    snapshot: requestContext.snapshot,
    baseContext,
    userState: requestContext.userState,
    favoriteClientTrackIds: requestContext.favoriteClientTrackIds,
    profiles: requestContext.profiles,
  });

  return buildBaseContext({
    snapshot: requestContext.snapshot,
    favoriteClientTrackIds: requestContext.favoriteClientTrackIds,
    historyClientTrackIds: requestContext.historyClientTrackIds,
    sessionRecentTrackIds: requestContext.profiles.session.recentTrackIds,
    currentTrackId: input.currentTrackId ?? null,
    recentRecommendationTrackIds: input.recentRecommendationTrackIds ?? [],
    skippedTrackIds: input.skippedTrackIds ?? [],
    mode: input.mode ?? "autoplay",
    userFeatures,
  });
}

function resolveRecommendedTrack(
  ranking: RecommendedTrack,
  favoriteTrackIds: Set<string>,
  trackByClientId: Map<string, Track>,
) {
  const clientTrackId = ranking.preferredVariantId;
  const track = trackByClientId.get(clientTrackId);

  if (!track) {
    return null;
  }

  return {
    canonicalTrackId: ranking.canonicalTrackId,
    preferredVariantId: clientTrackId,
    score: ranking.score,
    sourceChannels: ranking.sourceChannels,
    explanation: ranking.explanation,
    track: serializeTrackForClient(track, {
      isFavorite: favoriteTrackIds.has(track.id),
    }),
  };
}

async function logRecommendationEvent(
  prisma: PrismaClient,
  userId: string,
  eventType: RecommendationEventType,
  trackId: string | null,
  payload: unknown,
) {
  await prisma.userRecommendationEvent.create({
    data: {
      userId,
      trackId,
      eventType,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

function resolveCanonicalTrackId(snapshot: RecommendationCatalogSnapshot, track: Track, fallbackExternalTrackId?: string | null) {
  return (
    snapshot.canonicalIdByVariantTrackId[toExternalTrackId(track)] ??
    (fallbackExternalTrackId ? snapshot.canonicalIdByVariantTrackId[fallbackExternalTrackId] : null) ??
    null
  );
}

export const recommendationService = {
  async getNextRecommendedTrack(
    prisma: PrismaClient,
    userId: string,
    input: {
      currentTrackId?: string | null;
      recentRecommendationTrackIds?: string[];
      skippedTrackIds?: string[];
      mode?: RecommendationMode;
    },
  ) {
    const requestId = randomUUID();
    const requestContext = await createRequestContext(prisma, userId);
    const favoriteTrackIds = new Set(requestContext.userState.favorites.map((favorite) => favorite.trackId));
    const mode = input.mode ?? "autoplay";
    const context = await buildRecommendationContext(requestContext, {
      ...input,
      mode,
    });
    const pending = await getPendingWave(requestContext.cacheStore);
    const pendingAlreadySurfaced =
      !!pending &&
      pending.mode === mode &&
      pending.basisCurrentCanonicalTrackId === context.currentCanonicalTrackId &&
      context.recentRecommendationIds.includes(pending.item.canonicalTrackId);
    let resolved: ResolvedRecommendedTrack | null = null;
    if (pendingAlreadySurfaced) {
      return null;
    }

    if (pending && pending.mode === mode && pending.basisCurrentCanonicalTrackId === context.currentCanonicalTrackId) {
      resolved = pending.item;
    } else {
      const ranking = await requestContext.engine.getRecommendedTracks(
        {
          mode,
          canonicalTrackId: context.currentCanonicalTrackId ?? undefined,
        },
        context,
      );
      const selected = pickFirstWaveCandidate(ranking, context, requestContext.snapshot);
      if (!selected) {
        await clearPendingWave(requestContext.cacheStore);
        return null;
      }

      resolved = resolveRecommendedTrack(selected, favoriteTrackIds, requestContext.trackByClientId);
      if (!resolved) {
        await clearPendingWave(requestContext.cacheStore);
        return null;
      }

      await setPendingWave(requestContext.cacheStore, {
        mode,
        basisCurrentCanonicalTrackId: context.currentCanonicalTrackId ?? null,
        basisRecentRecommendationIds: context.recentRecommendationIds,
        requestId,
        strategy: context.userFeatures?.strategy ?? "user-feed",
        contextSummary: context.userFeatures?.contextSummary ?? buildDefaultContextSummary(context),
        seedLabel: buildSeedLabel(requestContext.snapshot, null),
        item: resolved,
      });
    }

    return {
      requestId,
      strategy: context.userFeatures?.strategy ?? "user-feed",
      contextSummary: context.userFeatures?.contextSummary ?? "Личный вкус пользователя",
      seed: {
        mode,
      },
      seedLabel: buildSeedLabel(requestContext.snapshot, null),
      ...resolved!,
    };
  },

  async getRecommendationStreamBatch(
    prisma: PrismaClient,
    userId: string,
    input: {
      limit?: number;
      mode?: RecommendationMode;
      seedTrackId?: string | null;
      currentTrackId?: string | null;
      excludeTrackIds?: string[];
      recentRecommendationTrackIds?: string[];
    },
  ) {
    const requestId = randomUUID();
    const requestContext = await createRequestContext(prisma, userId);
    const favoriteTrackIds = new Set(requestContext.userState.favorites.map((favorite) => favorite.trackId));
    const mode = input.mode ?? "autoplay";
    const isWaveMode = true;
    const context = await buildRecommendationContext(requestContext, {
      currentTrackId: input.currentTrackId ?? input.seedTrackId ?? null,
      recentRecommendationTrackIds: input.recentRecommendationTrackIds ?? [],
      skippedTrackIds: [],
      mode,
    });
    const excludedIds = new Set(mapTrackIdsToCanonicalIds(requestContext.snapshot, input.excludeTrackIds ?? []));
    const recentCanonicalRecommendationIds = new Set(context.recentRecommendationIds);
    const pending = await getPendingWave(requestContext.cacheStore);
    const pendingMatchesCurrent =
      !!pending && pending.mode === mode && pending.basisCurrentCanonicalTrackId === context.currentCanonicalTrackId;
    const pendingAlreadySurfaced =
      pendingMatchesCurrent &&
      (excludedIds.has(pending.item.canonicalTrackId) || recentCanonicalRecommendationIds.has(pending.item.canonicalTrackId));
    const pendingIsReusable = pendingMatchesCurrent && !pendingAlreadySurfaced;

    let items: ResolvedRecommendedTrack[] = [];
    if (pendingIsReusable) {
      items = [pending!.item];
    }

    if (!items.length && !pendingAlreadySurfaced) {
      const ranking = await requestContext.engine.getRecommendedTracks(
        {
          mode,
          canonicalTrackId: context.currentCanonicalTrackId ?? undefined,
        },
        context,
      );
      const selected = pickFirstWaveCandidate(
        ranking.filter((track) => !excludedIds.has(track.canonicalTrackId) && !recentCanonicalRecommendationIds.has(track.canonicalTrackId)),
        context,
        requestContext.snapshot,
      );
      if (selected) {
        const resolved = resolveRecommendedTrack(selected, favoriteTrackIds, requestContext.trackByClientId);
        if (resolved) {
          items = [resolved];
          await setPendingWave(requestContext.cacheStore, {
            mode,
            basisCurrentCanonicalTrackId: context.currentCanonicalTrackId ?? null,
            basisRecentRecommendationIds: context.recentRecommendationIds,
            requestId,
            strategy: context.userFeatures?.strategy ?? "user-feed",
            contextSummary: context.userFeatures?.contextSummary ?? buildDefaultContextSummary(context),
            seedLabel: buildSeedLabel(requestContext.snapshot, null),
            item: resolved,
          });
        }
      } else {
        await clearPendingWave(requestContext.cacheStore);
      }
    }

    return {
      requestId,
      strategy: context.userFeatures?.strategy ?? "user-feed",
      contextSummary: context.userFeatures?.contextSummary ?? "Личный вкус пользователя",
      seed: {
        mode,
      },
      seedLabel: buildSeedLabel(requestContext.snapshot, null),
      queueMode: isWaveMode ? "single-next" : "batch",
      visibleQueueLength: items.length,
      items,
    };
  },

  async saveOnboardingProfile(
    prisma: PrismaClient,
    userId: string,
    input: RecommendationOnboardingProfileInput,
  ) {
    const cacheStore = await createCacheStore(prisma, userId);
    await updateBootstrapProfile({
      cacheStore,
      input,
    });
    await clearPendingWave(cacheStore);

    return {
      ok: true,
      discoveryLevel: input.discoveryLevel ?? "balanced",
    };
  },

  async recordRecommendationImpressions(
    prisma: PrismaClient,
    userId: string,
    input: {
      items: Array<{
        requestId: string;
        surface: string;
        position: number;
        trackId: string;
        occurredAt: string;
      }>;
    },
  ) {
    if (!input.items.length) {
      return;
    }

    const ensuredTracks = await ensureSyncTracks(
      prisma,
      input.items.map((item) => item.trackId),
    );
    const requestContext = await createRequestContext(prisma, userId);
    const events: RecommendationImpressionEvent[] = [];

    input.items.forEach((item) => {
      const track = ensuredTracks.get(item.trackId.trim());
      if (!track) {
        return;
      }

      const canonicalTrackId = resolveCanonicalTrackId(requestContext.snapshot, track, item.trackId);
      if (!canonicalTrackId) {
        return;
      }

      events.push({
        requestId: item.requestId,
        surface: item.surface,
        position: item.position,
        canonicalTrackId,
        occurredAt: item.occurredAt,
      });
    });

    await updateProfilesFromImpressions({
      cacheStore: requestContext.cacheStore,
      config: defaultRecommendationConfig,
      events,
    });

    await Promise.all(
      events.map(async (event) => {
        const track = ensuredTracks.get(
          input.items.find((item) => item.requestId === event.requestId && item.position === event.position)?.trackId.trim() ?? "",
        );
        await logRecommendationEvent(prisma, userId, "IMPRESSION", track?.id ?? null, {
          ...event,
          trackId: track ? toExternalTrackId(track) : null,
        });
      }),
    );
  },

  async recordRecommendationInteraction(
    prisma: PrismaClient,
    userId: string,
    input: {
      requestId: string;
      surface: string;
      position: number;
      trackId: string;
      action: RecommendationInteractionAction;
      occurredAt: string;
      listenedMs?: number;
      trackDurationMs?: number;
      playlistId?: string;
      metadata?: Record<string, unknown> | null;
    },
  ) {
    const track = await ensureSyncTrack(prisma, input.trackId);
    const requestContext = await createRequestContext(prisma, userId);
    const canonicalTrackId = resolveCanonicalTrackId(requestContext.snapshot, track, input.trackId);
    if (!canonicalTrackId) {
      return;
    }

    const event: RecommendationInteractionEvent = {
      requestId: input.requestId,
      surface: input.surface,
      position: input.position,
      canonicalTrackId,
      action: input.action,
      occurredAt: input.occurredAt,
      listenedMs: input.listenedMs,
      trackDurationMs: input.trackDurationMs,
      playlistId: input.playlistId,
      metadata: input.metadata,
    };

    await updateProfilesFromInteraction({
      cacheStore: requestContext.cacheStore,
      snapshot: requestContext.snapshot,
      config: defaultRecommendationConfig,
      event,
    });
    await clearPendingWave(requestContext.cacheStore);
    await logRecommendationEvent(prisma, userId, "INTERACTION", track.id, {
      ...event,
      trackId: input.trackId,
    });
  },

  async updatePlaybackAffinity(
    prisma: PrismaClient,
    userId: string,
    input: {
      trackId: string;
      listenedMs: number;
      trackDurationMs: number;
      occurredAt: string;
      endedNaturally: boolean;
      wasSkipped: boolean;
      sessionId: string;
      seedChannels?: RecommendationChannel[];
    },
  ) {
    const track = await ensureSyncTrack(prisma, input.trackId);
    const requestContext = await createRequestContext(prisma, userId);
    const canonicalTrackId = resolveCanonicalTrackId(requestContext.snapshot, track, input.trackId);

    if (!canonicalTrackId) {
      return;
    }

    const event: PlaybackAffinityEvent = {
      canonicalTrackId,
      listenedMs: input.listenedMs,
      trackDurationMs: input.trackDurationMs,
      occurredAt: input.occurredAt,
      endedNaturally: input.endedNaturally,
      wasSkipped: input.wasSkipped,
      sessionId: input.sessionId,
      seedChannels: input.seedChannels?.length ? input.seedChannels : ["userAffinityRetrieval"],
    };

    await requestContext.engine.updateAffinityFromPlayback(event);
    await clearPendingWave(requestContext.cacheStore);
    await logRecommendationEvent(prisma, userId, "PLAYBACK", track.id, {
      ...event,
      trackId: input.trackId,
    });
  },

  async updateFavoriteAffinity(
    prisma: PrismaClient,
    userId: string,
    input: {
      trackId: string;
      occurredAt: string;
      isFavorite: boolean;
    },
  ) {
    const track = await ensureSyncTrack(prisma, input.trackId);
    const requestContext = await createRequestContext(prisma, userId);
    const canonicalTrackId = resolveCanonicalTrackId(requestContext.snapshot, track, input.trackId);

    if (!canonicalTrackId) {
      return;
    }

    const event: FavoriteAffinityEvent = {
      canonicalTrackId,
      occurredAt: input.occurredAt,
      isFavorite: input.isFavorite,
    };

    await requestContext.engine.updateAffinityFromFavorite(event);
    await clearPendingWave(requestContext.cacheStore);
    await logRecommendationEvent(prisma, userId, "FAVORITE", track.id, {
      ...event,
      trackId: input.trackId,
    });
  },

  async updatePlaylistAffinity(
    prisma: PrismaClient,
    userId: string,
    input: {
      trackId: string;
      playlistId: string;
      occurredAt: string;
      isAdded: boolean;
    },
  ) {
    const track = await ensureSyncTrack(prisma, input.trackId);
    const requestContext = await createRequestContext(prisma, userId);
    const canonicalTrackId = resolveCanonicalTrackId(requestContext.snapshot, track, input.trackId);

    if (!canonicalTrackId) {
      return;
    }

    const event: PlaylistAffinityEvent = {
      canonicalTrackId,
      playlistId: input.playlistId,
      occurredAt: input.occurredAt,
      isAdded: input.isAdded,
    };

    await requestContext.engine.updateAffinityFromPlaylist(event);
    await clearPendingWave(requestContext.cacheStore);
    await logRecommendationEvent(prisma, userId, "PLAYLIST", track.id, {
      ...event,
      trackId: input.trackId,
    });
  },

  async updateDislikeAffinity(
    prisma: PrismaClient,
    userId: string,
    input: {
      trackId: string;
      occurredAt: string;
      isDisliked: boolean;
    },
  ) {
    const track = await ensureSyncTrack(prisma, input.trackId);
    const requestContext = await createRequestContext(prisma, userId);
    const canonicalTrackId = resolveCanonicalTrackId(requestContext.snapshot, track, input.trackId);

    if (!canonicalTrackId) {
      return;
    }

    const event: DislikeAffinityEvent = {
      canonicalTrackId,
      occurredAt: input.occurredAt,
      isDisliked: input.isDisliked,
    };

    await requestContext.engine.updateAffinityFromDislike(event);
    await clearPendingWave(requestContext.cacheStore);
    await logRecommendationEvent(prisma, userId, "DISLIKE", track.id, {
      ...event,
      trackId: input.trackId,
    });
  },
};
