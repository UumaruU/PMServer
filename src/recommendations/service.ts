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
import {
  mapUnifiedEventTypeToStorageType,
  normalizeUnifiedRecommendationEvent,
  type UnifiedRecommendationEvent,
  type UnifiedRecommendationEventInput,
} from "../recommendation/events/recommendationEvents";
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
  RecommendationSourceArtist,
  RecommendationSourceProviderMetadata,
  RecommendationSourceRelease,
  RecommendationSourceTrack,
  RecommendedArtist,
  RecommendedTrack,
  UserRecommendationFeatures,
  WeightedEdge,
} from "../recommendation/types";
import { discoveryService } from "../discovery/discovery.service";
import { serializeTrackForClient } from "../tracks/serializers";
import { ensureSyncTrack, ensureSyncTracks, toExternalTrackId } from "../tracks/service";
import { trackDurationToMilliseconds } from "../tracks/duration";

const NON_PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NON_FULL_PLAYABLE_PROVIDER_IDS = new Set(["deezer"]);

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
  lastfm: {
    providerId: "lastfm",
    sourcePriority: 45,
    sourceTrustScore: 0.7,
    popularityPrior: 0.35,
  },
  deezer: {
    providerId: "deezer",
    sourcePriority: 55,
    sourceTrustScore: 0.72,
    popularityPrior: 0.35,
  },
  listenbrainz: {
    providerId: "listenbrainz",
    sourcePriority: 48,
    sourceTrustScore: 0.68,
    popularityPrior: 0.25,
  },
};

type UserStateRecord = Awaited<ReturnType<typeof getUserState>>;
type RequestContext = Awaited<ReturnType<typeof createRequestContext>>;
type ResolvedRecommendedTrack = NonNullable<ReturnType<typeof resolveRecommendedTrack>>;

interface RecommendationEventLogDetails {
  artistId?: string | null;
  sessionId?: string | null;
  sourceSurface?: string | null;
  position?: number | null;
  occurredAt?: string | Date | null;
  recommendationRequestId?: string | null;
  context?: Record<string, unknown> | null;
  reasonSnapshot?: Record<string, unknown> | null;
  featuresSnapshot?: Record<string, unknown> | null;
}

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

function createDeterministicHash(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0).toString(16);
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

function getRecommendationAudioUrl(providerId: string, audioUrl?: string | null) {
  if (!audioUrl || NON_FULL_PLAYABLE_PROVIDER_IDS.has(providerId)) {
    return "";
  }

  return audioUrl;
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
    audioUrl: getRecommendationAudioUrl(providerId, track.audioUrl),
    duration: trackDurationToMilliseconds(track.duration) ?? 0,
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

function toRecommendationSourceTrackFromIndexedSource(
  source: Awaited<ReturnType<PrismaClient["trackSource"]["findMany"]>>[number] & {
    legacyTrack?: Track | null;
    canonicalTrack?: {
      id: string;
      title: string;
      artistName: string;
      albumTitle: string | null;
      coverUrl: string | null;
      durationMs: number | null;
      musicBrainzRecordingId: string | null;
      musicBrainzArtistId: string | null;
      musicBrainzReleaseId: string | null;
      musicBrainzReleaseGroupId: string | null;
      titleFlavor: string[];
    } | null;
  },
  favoriteTrackIds = new Set<string>(),
): RecommendationSourceTrack {
  const legacyTrack = source.legacyTrack ?? null;
  const id = legacyTrack ? toExternalTrackId(legacyTrack) : source.clientTrackId ?? `${source.providerId}:${source.sourceTrackId}`;
  const duration =
    source.durationMs ??
    source.canonicalTrack?.durationMs ??
    trackDurationToMilliseconds(legacyTrack?.duration) ??
    0;
  const audioUrl = getRecommendationAudioUrl(source.providerId, source.audioUrl ?? legacyTrack?.audioUrl ?? "");

  return {
    id,
    providerId: source.providerId,
    providerTrackId: source.sourceTrackId,
    title: source.title || source.canonicalTrack?.title || legacyTrack?.title || "",
    artist: source.artistName || source.canonicalTrack?.artistName || legacyTrack?.artistName || "",
    coverUrl: source.coverUrl ?? source.canonicalTrack?.coverUrl ?? legacyTrack?.coverUrl ?? "",
    audioUrl,
    duration,
    sourceUrl: source.sourceUrl ?? legacyTrack?.audioUrl ?? `https://example.invalid/tracks/${encodeURIComponent(source.sourceTrackId)}`,
    isFavorite: legacyTrack ? favoriteTrackIds.has(legacyTrack.id) : false,
    metadataStatus:
      source.musicBrainzRecordingId || source.musicBrainzArtistId || source.musicBrainzReleaseId ? "enriched" : "raw",
    albumTitle: source.albumTitle ?? source.canonicalTrack?.albumTitle ?? legacyTrack?.albumTitle ?? undefined,
    musicBrainzRecordingId: source.musicBrainzRecordingId ?? source.canonicalTrack?.musicBrainzRecordingId ?? null,
    musicBrainzArtistId: source.musicBrainzArtistId ?? source.canonicalTrack?.musicBrainzArtistId ?? null,
    musicBrainzReleaseId: source.musicBrainzReleaseId ?? source.canonicalTrack?.musicBrainzReleaseId ?? null,
    musicBrainzReleaseGroupId:
      source.musicBrainzReleaseGroupId ?? source.canonicalTrack?.musicBrainzReleaseGroupId ?? null,
    titleFlavor: source.canonicalTrack?.titleFlavor as RecommendationSourceTrack["titleFlavor"],
    canonicalId: source.canonicalTrackId,
    sourcePriority: PROVIDER_METADATA[source.providerId]?.sourcePriority,
    sourceTrustScore: Math.max(PROVIDER_METADATA[source.providerId]?.sourceTrustScore ?? 0.4, source.qualityScore),
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

  const favoriteArtistIds = new Set([
    ...context.favoritedTrackIds
      .map((trackId) => snapshot.tracksById[trackId]?.primaryCanonicalArtistId ?? null)
      .filter((artistId): artistId is string => !!artistId),
    ...(context.userFeatures?.topArtists ?? [])
      .filter((entry) => entry.score >= 8)
      .map((entry) => entry.id),
  ]);
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

  const newArtistCandidate = ranking.find((candidate) => {
    const track = snapshot.tracksById[candidate.canonicalTrackId];
    if (!track) {
      return false;
    }

    const isExactFavorite =
      context.favoritedTrackIds.includes(candidate.canonicalTrackId) ||
      (!!track.preferredVariantId && !!context.userFeatures?.favoriteVariantIds.includes(track.preferredVariantId));
    const isFavoriteArtist = !!track.primaryCanonicalArtistId && favoriteArtistIds.has(track.primaryCanonicalArtistId);
    return !isExactFavorite && !isFavoriteArtist;
  });

  if (newArtistCandidate) {
    return newArtistCandidate;
  }

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
  const [legacyTracks, canonicalTracks, trackSources, artists, similarities, edges] = await Promise.all([
    prisma.track.aggregate({
      _count: {
        _all: true,
      },
      _max: {
        updatedAt: true,
      },
    }),
    prisma.canonicalTrack.aggregate({
      _count: {
        _all: true,
      },
      _max: {
        updatedAt: true,
      },
    }),
    prisma.trackSource.aggregate({
      _count: {
        _all: true,
      },
      _max: {
        updatedAt: true,
      },
    }),
    prisma.artist.aggregate({
      _count: {
        _all: true,
      },
      _max: {
        updatedAt: true,
      },
    }),
    prisma.artistSimilarity.aggregate({
      _count: {
        _all: true,
      },
      _max: {
        updatedAt: true,
      },
    }),
    prisma.trackEdge.aggregate({
      _count: {
        _all: true,
      },
      _max: {
        updatedAt: true,
      },
    }),
  ]);

  return [
    `legacy:${legacyTracks._count._all}:${legacyTracks._max.updatedAt?.toISOString() ?? "none"}`,
    `canonical:${canonicalTracks._count._all}:${canonicalTracks._max.updatedAt?.toISOString() ?? "none"}`,
    `sources:${trackSources._count._all}:${trackSources._max.updatedAt?.toISOString() ?? "none"}`,
    `artists:${artists._count._all}:${artists._max.updatedAt?.toISOString() ?? "none"}`,
    `similar:${similarities._count._all}:${similarities._max.updatedAt?.toISOString() ?? "none"}`,
    `edges:${edges._count._all}:${edges._max.updatedAt?.toISOString() ?? "none"}`,
  ].join("|");
}

async function buildCatalogSnapshot(prisma: PrismaClient) {
  const revision = await getCatalogSnapshotRevision(prisma);
  if (catalogSnapshotCache?.revision === revision) {
    return catalogSnapshotCache;
  }

  const [tracks, trackSources, artists, similarities] = await Promise.all([
    prisma.track.findMany({
      orderBy: [
        {
          updatedAt: "desc",
        },
        {
          id: "asc",
        },
      ],
    }),
    prisma.trackSource.findMany({
      where: {
        indexStatus: {
          in: ["ACTIVE", "TRUSTED"],
        },
      },
      include: {
        legacyTrack: true,
        canonicalTrack: true,
      },
      orderBy: [
        {
          updatedAt: "desc",
        },
        {
          id: "asc",
        },
      ],
    }),
    prisma.artist.findMany({
      orderBy: [
        {
          updatedAt: "desc",
        },
        {
          id: "asc",
        },
      ],
    }),
    prisma.artistSimilarity.findMany({
      include: {
        sourceArtist: true,
        targetArtist: true,
      },
      orderBy: [
        {
          score: "desc",
        },
        {
          id: "asc",
        },
      ],
    }),
  ]);
  const trackByClientId = new Map(tracks.map((track) => [toExternalTrackId(track), track] as const));
  trackSources.forEach((source) => {
    if (!source.legacyTrack) {
      return;
    }

    trackByClientId.set(toExternalTrackId(source.legacyTrack), source.legacyTrack);
    trackByClientId.set(source.clientTrackId ?? `${source.providerId}:${source.sourceTrackId}`, source.legacyTrack);
  });

  const sourceTracksById = new Map<string, RecommendationSourceTrack>();
  trackSources.forEach((source) => {
    const mapped = toRecommendationSourceTrackFromIndexedSource(source);
    sourceTracksById.set(mapped.id, mapped);
  });
  tracks.forEach((track) => {
    const id = toExternalTrackId(track);
    if (!sourceTracksById.has(id)) {
      sourceTracksById.set(id, toRecommendationSourceTrack(track));
    }
  });

  const sourceArtists: RecommendationSourceArtist[] = artists.map((artist) => ({
    id: artist.id,
    name: artist.name,
    musicBrainzArtistId: artist.musicBrainzArtistId,
    type: artist.type ?? undefined,
    country: artist.country ?? undefined,
    area: artist.area ?? undefined,
    tags: artist.tags,
    imageUrl: artist.imageUrl ?? undefined,
  }));
  const releaseById = new Map<string, RecommendationSourceRelease>();
  trackSources.forEach((source) => {
    const canonicalTrack = source.canonicalTrack;
    const releaseKey =
      canonicalTrack.musicBrainzReleaseId ??
      (canonicalTrack.albumTitle
        ? `soft:${createDeterministicHash(`${canonicalTrack.artistName}:${canonicalTrack.albumTitle}`)}`
        : null);
    if (!releaseKey) {
      return;
    }

    const id = canonicalTrack.musicBrainzReleaseId ? `release:${canonicalTrack.musicBrainzReleaseId}` : `release:${releaseKey}`;
    const existing = releaseById.get(id);
    releaseById.set(id, {
      id,
      title: canonicalTrack.albumTitle ?? canonicalTrack.title,
      musicBrainzReleaseId: canonicalTrack.musicBrainzReleaseId,
      musicBrainzReleaseGroupId: canonicalTrack.musicBrainzReleaseGroupId,
      artistName: canonicalTrack.artistName,
      kind: "other",
      date: canonicalTrack.releaseDate ?? undefined,
      coverUrl: canonicalTrack.coverUrl ?? undefined,
      trackTitles: dedupe([...(existing?.trackTitles ?? []), canonicalTrack.title]),
      trackIds: dedupe([...(existing?.trackIds ?? []), source.clientTrackId ?? `${source.providerId}:${source.sourceTrackId}`]),
    });
  });
  const snapshot = buildRecommendationCatalogSnapshot({
    tracks: [...sourceTracksById.values()],
    artists: sourceArtists,
    releases: [...releaseById.values()],
    providerMetadata: PROVIDER_METADATA,
    config: defaultRecommendationConfig,
  });

  similarities.forEach((similarity) => {
    const leftId = similarity.sourceArtistId;
    const rightId = similarity.targetArtistId;
    if (!snapshot.artistsById[leftId] || !snapshot.artistsById[rightId]) {
      return;
    }

    const edge: WeightedEdge = {
      leftId,
      rightId,
      weight: similarity.score,
      source: similarity.providerId,
      confidence: similarity.confidence,
      reason: similarity.reason ?? "provider-similarity",
    };
    snapshot.relatedArtists[leftId] = [...(snapshot.relatedArtists[leftId] ?? []), edge]
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 24);
    snapshot.artistsById[leftId].relatedArtistIds = dedupe([
      ...snapshot.artistsById[leftId].relatedArtistIds,
      rightId,
    ]);
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
  details: RecommendationEventLogDetails = {},
) {
  await prisma.userRecommendationEvent.create({
    data: {
      userId,
      trackId,
      artistId: details.artistId ?? undefined,
      sessionId: details.sessionId ?? undefined,
      sourceSurface: details.sourceSurface ?? undefined,
      position: details.position ?? undefined,
      occurredAt: details.occurredAt ? new Date(details.occurredAt) : undefined,
      recommendationRequestId: details.recommendationRequestId ?? undefined,
      context: details.context === undefined ? undefined : (details.context as Prisma.InputJsonValue),
      reasonSnapshot:
        details.reasonSnapshot === undefined ? undefined : (details.reasonSnapshot as Prisma.InputJsonValue),
      featuresSnapshot:
        details.featuresSnapshot === undefined ? undefined : (details.featuresSnapshot as Prisma.InputJsonValue),
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

function getContextNumber(context: Record<string, unknown> | null | undefined, key: string, fallback = 0) {
  const value = context?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getContextBoolean(context: Record<string, unknown> | null | undefined, key: string, fallback = false) {
  const value = context?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function getContextString(context: Record<string, unknown> | null | undefined, key: string) {
  const value = context?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getContextSeedChannels(context: Record<string, unknown> | null | undefined) {
  const value = context?.seedChannels;
  if (!Array.isArray(value)) {
    return undefined;
  }

  const channels = value.filter((entry): entry is RecommendationChannel => typeof entry === "string");
  return channels.length ? channels : undefined;
}

async function buildRecommendationEventSnapshots(params: {
  cacheStore: RequestContext["cacheStore"];
  canonicalTrackId?: string | null;
  event: Pick<UnifiedRecommendationEvent, "position" | "recommendationRequestId">;
}) {
  if (!params.canonicalTrackId) {
    return {};
  }

  const cached = await params.cacheStore.getJson<{
    seed: RecommendationSeed;
    context: RecommendationContext;
    results: RecommendedTrack[];
  }>(RECOMMENDATION_LAST_TRACK_RANKING_KEY);
  if (!cached?.results?.length) {
    return {};
  }

  const result =
    cached.results.find(
      (candidate, index) =>
        candidate.canonicalTrackId === params.canonicalTrackId &&
        (params.event.position === undefined || params.event.position === index),
    ) ?? cached.results.find((candidate) => candidate.canonicalTrackId === params.canonicalTrackId);

  if (!result) {
    return {};
  }

  return {
    reasonSnapshot: {
      recommendationRequestId: params.event.recommendationRequestId ?? null,
      canonicalTrackId: result.canonicalTrackId,
      preferredVariantId: result.preferredVariantId,
      sourceChannels: result.sourceChannels,
      score: result.score,
      explanation: result.explanation,
    },
    featuresSnapshot: {
      seed: cached.seed,
      mode: cached.context.mode,
      currentCanonicalTrackId: cached.context.currentCanonicalTrackId ?? null,
      recentRecommendationIds: cached.context.recentRecommendationIds,
      userFeatures: cached.context.userFeatures ?? null,
    },
  };
}

function buildUnifiedLogDetails(params: {
  event: UnifiedRecommendationEvent;
  canonicalTrackId?: string | null;
  fallbackArtistId?: string | null;
  snapshots?: {
    reasonSnapshot?: Record<string, unknown> | null;
    featuresSnapshot?: Record<string, unknown> | null;
  };
}): RecommendationEventLogDetails {
  return {
    artistId: params.event.artistId ?? params.fallbackArtistId ?? null,
    sessionId: params.event.sessionId ?? null,
    sourceSurface: params.event.sourceSurface ?? null,
    position: params.event.position ?? null,
    occurredAt: params.event.timestamp,
    recommendationRequestId: params.event.recommendationRequestId ?? null,
    context: {
      ...(params.event.context ?? {}),
      canonicalTrackId: params.canonicalTrackId ?? null,
    },
    reasonSnapshot: params.snapshots?.reasonSnapshot ?? null,
    featuresSnapshot: params.snapshots?.featuresSnapshot ?? null,
  };
}

async function applyUnifiedRecommendationEvent(
  prisma: PrismaClient,
  userId: string,
  event: UnifiedRecommendationEvent,
) {
  const storageEventType = mapUnifiedEventTypeToStorageType(event.type);

  if (!event.trackId) {
    await logRecommendationEvent(prisma, userId, storageEventType, null, event, buildUnifiedLogDetails({ event }));
    return;
  }

  const track = await ensureSyncTrack(prisma, event.trackId);
  const requestContext = await createRequestContext(prisma, userId);
  const canonicalTrackId = resolveCanonicalTrackId(requestContext.snapshot, track, event.trackId);
  const snapshots = await buildRecommendationEventSnapshots({
    cacheStore: requestContext.cacheStore,
    canonicalTrackId,
    event,
  });
  const fallbackArtistId = canonicalTrackId
    ? requestContext.snapshot.tracksById[canonicalTrackId]?.primaryCanonicalArtistId ?? null
    : null;
  const logDetails = buildUnifiedLogDetails({
    event,
    canonicalTrackId,
    fallbackArtistId,
    snapshots,
  });

  if (!canonicalTrackId) {
    await logRecommendationEvent(prisma, userId, storageEventType, track.id, event, logDetails);
    return;
  }

  if (event.type === "impression") {
    const impressionEvent: RecommendationImpressionEvent = {
      requestId: event.recommendationRequestId ?? "unknown",
      surface: event.sourceSurface ?? "unknown",
      position: event.position ?? 0,
      canonicalTrackId,
      occurredAt: event.timestamp,
    };
    await updateProfilesFromImpressions({
      cacheStore: requestContext.cacheStore,
      config: defaultRecommendationConfig,
      events: [impressionEvent],
    });
  }

  if (event.type === "play" || event.type === "skip") {
    const playbackEvent: PlaybackAffinityEvent = {
      canonicalTrackId,
      listenedMs: getContextNumber(event.context, "listenedMs"),
      trackDurationMs: getContextNumber(event.context, "trackDurationMs"),
      occurredAt: event.timestamp,
      endedNaturally: getContextBoolean(event.context, "endedNaturally", event.type === "play"),
      wasSkipped: event.type === "skip" || getContextBoolean(event.context, "wasSkipped"),
      sessionId: event.sessionId ?? getContextString(event.context, "sessionId") ?? "unknown",
      seedChannels: getContextSeedChannels(event.context) ?? ["userAffinityRetrieval"],
    };

    await requestContext.engine.updateAffinityFromPlayback(playbackEvent);
    await clearPendingWave(requestContext.cacheStore);

    if (playbackEvent.endedNaturally && !playbackEvent.wasSkipped) {
      await discoveryService.enqueueFromPlayback(prisma, userId, track.id, {
        listenedMs: playbackEvent.listenedMs,
        trackDurationMs: playbackEvent.trackDurationMs,
        occurredAt: playbackEvent.occurredAt,
        sessionId: playbackEvent.sessionId,
      });
    }
  }

  if (event.type === "like" || event.type === "save") {
    const favoriteEvent: FavoriteAffinityEvent = {
      canonicalTrackId,
      occurredAt: event.timestamp,
      isFavorite: true,
    };

    await requestContext.engine.updateAffinityFromFavorite(favoriteEvent);
    await clearPendingWave(requestContext.cacheStore);
    await discoveryService.enqueueFromFavorite(prisma, userId, track.id);
  }

  if (event.type === "add_to_playlist") {
    const playlistId =
      getContextString(event.context, "playlistId") ??
      getContextString(event.context, "playlist_id") ??
      event.recommendationRequestId ??
      "recommendation-event";
    const playlistEvent: PlaylistAffinityEvent = {
      canonicalTrackId,
      playlistId,
      occurredAt: event.timestamp,
      isAdded: true,
    };

    await requestContext.engine.updateAffinityFromPlaylist(playlistEvent);
    await clearPendingWave(requestContext.cacheStore);

    if (playlistId !== "recommendation-event") {
      await discoveryService.enqueueFromPlaylist(prisma, userId, playlistId, track.id);
    }
  }

  await logRecommendationEvent(prisma, userId, storageEventType, track.id, event, logDetails);
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
    let requestContext = await createRequestContext(prisma, userId);
    let favoriteTrackIds = new Set(requestContext.userState.favorites.map((favorite) => favorite.trackId));
    const mode = input.mode ?? "autoplay";
    let context = await buildRecommendationContext(requestContext, {
      ...input,
      mode,
    });
    const discoveryResult = await discoveryService.ensureCandidatePool(prisma, userId, {
      currentCanonicalTrackId: context.currentCanonicalTrackId,
      favoritedTrackIds: context.favoritedTrackIds,
      recentTrackIds: context.recentTrackIds,
      userFeatures: context.userFeatures,
    });

    if (discoveryResult.expanded) {
      catalogSnapshotCache = null;
      requestContext = await createRequestContext(prisma, userId);
      favoriteTrackIds = new Set(requestContext.userState.favorites.map((favorite) => favorite.trackId));
      context = await buildRecommendationContext(requestContext, {
        ...input,
        mode,
      });
    }

    const pending = await getPendingWave(requestContext.cacheStore);
    const pendingAlreadySurfaced =
      !!pending &&
      pending.mode === mode &&
      pending.basisCurrentCanonicalTrackId === context.currentCanonicalTrackId &&
      context.recentRecommendationIds.includes(pending.item.canonicalTrackId);
    let resolved: ResolvedRecommendedTrack | null = null;
    if (pendingAlreadySurfaced) {
      await clearPendingWave(requestContext.cacheStore);
    }

    if (
      pending &&
      !pendingAlreadySurfaced &&
      pending.mode === mode &&
      pending.basisCurrentCanonicalTrackId === context.currentCanonicalTrackId
    ) {
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
    let requestContext = await createRequestContext(prisma, userId);
    let favoriteTrackIds = new Set(requestContext.userState.favorites.map((favorite) => favorite.trackId));
    const mode = input.mode ?? "autoplay";
    const isWaveMode = true;
    let context = await buildRecommendationContext(requestContext, {
      currentTrackId: input.currentTrackId ?? input.seedTrackId ?? null,
      recentRecommendationTrackIds: input.recentRecommendationTrackIds ?? [],
      skippedTrackIds: [],
      mode,
    });
    const discoveryResult = await discoveryService.ensureCandidatePool(prisma, userId, {
      currentCanonicalTrackId: context.currentCanonicalTrackId,
      favoritedTrackIds: context.favoritedTrackIds,
      recentTrackIds: context.recentTrackIds,
      userFeatures: context.userFeatures,
    });

    if (discoveryResult.expanded) {
      catalogSnapshotCache = null;
      requestContext = await createRequestContext(prisma, userId);
      favoriteTrackIds = new Set(requestContext.userState.favorites.map((favorite) => favorite.trackId));
      context = await buildRecommendationContext(requestContext, {
        currentTrackId: input.currentTrackId ?? input.seedTrackId ?? null,
        recentRecommendationTrackIds: input.recentRecommendationTrackIds ?? [],
        skippedTrackIds: [],
        mode,
      });
    }
    const excludedIds = new Set(mapTrackIdsToCanonicalIds(requestContext.snapshot, input.excludeTrackIds ?? []));
    const recentCanonicalRecommendationIds = new Set(context.recentRecommendationIds);
    const pending = await getPendingWave(requestContext.cacheStore);
    const pendingMatchesCurrent =
      !!pending && pending.mode === mode && pending.basisCurrentCanonicalTrackId === context.currentCanonicalTrackId;
    const pendingAlreadySurfaced =
      pendingMatchesCurrent &&
      (excludedIds.has(pending.item.canonicalTrackId) || recentCanonicalRecommendationIds.has(pending.item.canonicalTrackId));
    const pendingIsReusable = pendingMatchesCurrent && !pendingAlreadySurfaced;
    if (pendingAlreadySurfaced) {
      await clearPendingWave(requestContext.cacheStore);
    }

    let items: ResolvedRecommendedTrack[] = [];
    if (pendingIsReusable) {
      items = [pending!.item];
    }

    if (!items.length) {
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
      contextSummary:
        context.userFeatures?.contextSummary ??
        (discoveryResult.expanded ? "Live discovery expansion found new playable candidates." : "Личный вкус пользователя"),
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

  async recordRecommendationEvents(
    prisma: PrismaClient,
    userId: string,
    input: {
      events: UnifiedRecommendationEventInput[];
    },
  ) {
    const events = input.events.map((event) => normalizeUnifiedRecommendationEvent(event));

    for (const event of events) {
      await applyUnifiedRecommendationEvent(prisma, userId, event);
    }
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

    if (input.endedNaturally && !input.wasSkipped) {
      await discoveryService.enqueueFromPlayback(prisma, userId, track.id, {
        listenedMs: input.listenedMs,
        trackDurationMs: input.trackDurationMs,
        occurredAt: input.occurredAt,
        sessionId: input.sessionId,
      });
    }
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

    if (input.isFavorite) {
      await discoveryService.enqueueFromFavorite(prisma, userId, track.id);
    }
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

    if (input.isAdded) {
      await discoveryService.enqueueFromPlaylist(prisma, userId, input.playlistId, track.id);
    }
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
