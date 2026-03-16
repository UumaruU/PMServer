import { Prisma, type PrismaClient, type RecommendationEventType, type Track } from "@prisma/client";

import { createRecommendationEngine } from "../recommendation";
import {
  RECOMMENDATION_LAST_ARTIST_RANKING_KEY,
  RECOMMENDATION_LAST_TRACK_RANKING_KEY,
  RECOMMENDATION_LAST_TRACK_RESULT_KEY,
  RECOMMENDATION_PROFILES_CACHE_KEY,
} from "../recommendation/caching/cacheKeys";
import { buildRecommendationCatalogSnapshot } from "../recommendation/canonical-graph/snapshotBuilder";
import { defaultRecommendationConfig } from "../recommendation/config/defaultRecommendationConfig";
import type {
  DislikeAffinityEvent,
  FavoriteAffinityEvent,
  PlaybackAffinityEvent,
  PlaylistAffinityEvent,
  RecommendationCatalogSnapshot,
  RecommendationChannel,
  RecommendationContext,
  RecommendationMode,
  RecommendationProfiles,
  RecommendationSeed,
  RecommendationSourceProviderMetadata,
  RecommendationSourceTrack,
  RecommendedArtist,
  RecommendedTrack,
} from "../recommendation/types";
import { serializeTrackForClient } from "../tracks/serializers";
import {
  ensureSyncTrack,
  toExternalTrackId,
} from "../tracks/service";

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

function dedupe(values: string[]) {
  return [...new Set(values.filter(Boolean))];
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

function toRecommendationSourceTrack(track: Track, favoriteTrackIds: Set<string>): RecommendationSourceTrack {
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

function mergeTrackTagsIntoCloud(
  cloud: Record<string, number>,
  snapshot: RecommendationCatalogSnapshot,
  canonicalTrackId: string | null | undefined,
) {
  if (!canonicalTrackId) {
    return cloud;
  }

  const track = snapshot.tracksById[canonicalTrackId];
  if (!track) {
    return cloud;
  }

  const nextCloud = { ...cloud };
  track.tagIds.forEach((tagId) => {
    nextCloud[tagId] = Math.max(nextCloud[tagId] ?? 0, track.tagWeights[tagId] ?? 1);
  });

  return nextCloud;
}

function buildCanonicalArtistLabel(
  snapshot: RecommendationCatalogSnapshot,
  canonicalTrackId: string | null | undefined,
) {
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

function sortFallbackSeedTrackIds(snapshot: RecommendationCatalogSnapshot) {
  return Object.values(snapshot.tracksById)
    .sort((left, right) => {
      if (left.quality.popularityPrior !== right.quality.popularityPrior) {
        return right.quality.popularityPrior - left.quality.popularityPrior;
      }

      if (left.quality.trustScore !== right.quality.trustScore) {
        return right.quality.trustScore - left.quality.trustScore;
      }

      return left.canonicalTrackId.localeCompare(right.canonicalTrackId);
    })
    .map((track) => track.canonicalTrackId);
}

function buildSeededContext(
  snapshot: RecommendationCatalogSnapshot,
  baseContext: RecommendationContext,
  seedCanonicalTrackId: string | null,
  mode: RecommendationMode,
  recentRecommendationIds: string[],
) {
  const seedTrack = seedCanonicalTrackId ? snapshot.tracksById[seedCanonicalTrackId] ?? null : null;

  return {
    ...baseContext,
    mode,
    currentCanonicalTrackId: baseContext.currentCanonicalTrackId ?? seedTrack?.canonicalTrackId ?? null,
    currentPrimaryArtistId: baseContext.currentPrimaryArtistId ?? seedTrack?.primaryCanonicalArtistId ?? null,
    currentFeaturedArtistIds: baseContext.currentFeaturedArtistIds.length
      ? baseContext.currentFeaturedArtistIds
      : seedTrack?.featuringCanonicalArtistIds ?? [],
    currentTrackTagIds: baseContext.currentTrackTagIds.length
      ? baseContext.currentTrackTagIds
      : seedTrack?.tagIds ?? [],
    currentArtistTagIds: baseContext.currentArtistTagIds.length
      ? baseContext.currentArtistTagIds
      : seedTrack?.primaryCanonicalArtistId
        ? snapshot.artistsById[seedTrack.primaryCanonicalArtistId]?.tagIds ?? []
        : [],
    currentReleaseId: baseContext.currentReleaseId ?? seedTrack?.canonicalReleaseId ?? null,
    currentFlavor:
      baseContext.currentFlavor ??
      seedTrack?.titleFlavor.find((flavor) => flavor !== "original") ??
      seedTrack?.titleFlavor[0] ??
      null,
    currentDurationMs: baseContext.currentDurationMs ?? seedTrack?.targetDurationMs ?? null,
    recentTrackIds: dedupe([seedTrack?.canonicalTrackId ?? "", ...baseContext.recentTrackIds]),
    recentArtistIds: dedupe([seedTrack?.primaryCanonicalArtistId ?? "", ...baseContext.recentArtistIds]),
    recentTagCloud: mergeTrackTagsIntoCloud(baseContext.recentTagCloud, snapshot, seedTrack?.canonicalTrackId),
    recentRecommendationIds,
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

      return (entry?.payload as T | undefined) ?? null;
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
            longTermProfile: profiles.longTerm as unknown as Prisma.InputJsonValue,
            sessionProfile: profiles.session as unknown as Prisma.InputJsonValue,
            entityProfile: profiles.entity as unknown as Prisma.InputJsonValue,
          },
          update: {
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
        },
        update: {
          payload: value as Prisma.InputJsonValue,
          expiresAt: null,
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
      },
      update: {
        payload: value as Prisma.InputJsonValue,
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

async function buildCatalogSnapshot(
  prisma: PrismaClient,
  favoriteTrackIds: Set<string>,
) {
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

  return buildRecommendationCatalogSnapshot({
    tracks: tracks.map((track) => toRecommendationSourceTrack(track, favoriteTrackIds)),
    artists: [],
    releases: [],
    providerMetadata: PROVIDER_METADATA,
    config: defaultRecommendationConfig,
  });
}

async function getUserState(prisma: PrismaClient, userId: string) {
  const [favorites, historyEvents, playlists] = await Promise.all([
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
      take: 80,
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
        createdAt: "desc",
      },
    }),
  ]);

  return {
    favorites,
    historyEvents,
    playlists,
  };
}

async function createRequestContext(prisma: PrismaClient, userId: string) {
  const userState = await getUserState(prisma, userId);
  const favoriteTrackIds = new Set(userState.favorites.map((favorite) => favorite.trackId));
  const snapshot = await buildCatalogSnapshot(prisma, favoriteTrackIds);
  const favoriteClientTrackIds = userState.favorites.map((favorite) => toExternalTrackId(favorite.track));
  const historyClientTrackIds = userState.historyEvents.map((event) => toExternalTrackId(event.track));
  const playlists = userState.playlists.map((playlist) => ({
    id: playlist.id,
    trackIds: playlist.tracks.map((item) => toExternalTrackId(item.track)),
    createdAt: playlist.createdAt.toISOString(),
    updatedAt: playlist.updatedAt.toISOString(),
  }));
  const cacheStore = await createCacheStore(prisma, userId);

  const engine = createRecommendationEngine(
    {
      catalogReader: {
        async getSnapshot() {
          return snapshot;
        },
      },
      userHistoryReader: {
        async getRecentHistory() {
          return mapTrackIdsToCanonicalIds(snapshot, historyClientTrackIds).map((trackId, index) => ({
            trackId,
            listenedAt:
              userState.historyEvents[index]?.createdAt.toISOString() ?? new Date(0).toISOString(),
          }));
        },
      },
      favoritesReader: {
        async getFavoriteTrackIds() {
          return mapTrackIdsToCanonicalIds(snapshot, favoriteClientTrackIds);
        },
      },
      playlistsReader: {
        async getPlaylists() {
          return playlists;
        },
      },
      playableVariantReader: {
        async getPlayableVariantIds(canonicalTrackId) {
          return snapshot.playableVariantsByCanonicalTrackId[canonicalTrackId] ?? [];
        },
        async resolvePreferredVariantId(canonicalTrackId) {
          return snapshot.tracksById[canonicalTrackId]?.preferredVariantId ?? null;
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
    snapshot,
    userState,
    favoriteClientTrackIds,
    historyClientTrackIds,
    playlists,
  };
}

function buildBaseContext(params: {
  snapshot: RecommendationCatalogSnapshot;
  favoriteClientTrackIds: string[];
  historyClientTrackIds: string[];
  mode: RecommendationMode;
  currentTrackId?: string | null;
  recentRecommendationTrackIds?: string[];
  skippedTrackIds?: string[];
}) {
  const favoriteCanonicalTrackIds = mapTrackIdsToCanonicalIds(
    params.snapshot,
    params.favoriteClientTrackIds,
  );
  const historyCanonicalTrackIds = mapTrackIdsToCanonicalIds(params.snapshot, params.historyClientTrackIds);
  const currentCanonicalTrackId = params.currentTrackId
    ? params.snapshot.canonicalIdByVariantTrackId[params.currentTrackId] ?? null
    : null;
  const recentCanonicalTrackIds = dedupe([
    currentCanonicalTrackId ?? "",
    ...historyCanonicalTrackIds,
    ...favoriteCanonicalTrackIds,
  ]).slice(0, defaultRecommendationConfig.autoplay.sessionCentroidWindowSize);
  const tagCloudTrackIds = dedupe([...recentCanonicalTrackIds, ...favoriteCanonicalTrackIds]);
  const currentTrack = currentCanonicalTrackId
    ? params.snapshot.tracksById[currentCanonicalTrackId] ?? null
    : null;

  return {
    mode: params.mode,
    currentCanonicalTrackId,
    currentPrimaryArtistId: currentTrack?.primaryCanonicalArtistId ?? null,
    currentFeaturedArtistIds: currentTrack?.featuringCanonicalArtistIds ?? [],
    currentTrackTagIds: currentTrack?.tagIds ?? [],
    currentArtistTagIds: currentTrack?.primaryCanonicalArtistId
      ? params.snapshot.artistsById[currentTrack.primaryCanonicalArtistId]?.tagIds ?? []
      : [],
    currentReleaseId: currentTrack?.canonicalReleaseId ?? null,
    currentFlavor:
      currentTrack?.titleFlavor.find((flavor) => flavor !== "original") ??
      currentTrack?.titleFlavor[0] ??
      null,
    currentDurationMs: currentTrack?.targetDurationMs ?? null,
    recentTrackIds: recentCanonicalTrackIds,
    recentArtistIds: dedupe(
      [...recentCanonicalTrackIds, ...favoriteCanonicalTrackIds]
        .map((trackId) => params.snapshot.tracksById[trackId]?.primaryCanonicalArtistId ?? "")
        .filter(Boolean),
    ),
    recentTagCloud: buildRecentTagCloud(params.snapshot, tagCloudTrackIds),
    recentRecommendationIds: mapTrackIdsToCanonicalIds(
      params.snapshot,
      params.recentRecommendationTrackIds ?? [],
    ),
    skippedTrackIds: mapTrackIdsToCanonicalIds(params.snapshot, params.skippedTrackIds ?? []),
    favoritedTrackIds: favoriteCanonicalTrackIds,
  } satisfies RecommendationContext;
}

function resolveRecommendedTrack(
  snapshot: RecommendationCatalogSnapshot,
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

function resolveSeedCanonicalTrackIds(
  snapshot: RecommendationCatalogSnapshot,
  input: {
    seedTrackId?: string | null;
    currentTrackId?: string | null;
    favoriteClientTrackIds: string[];
    historyClientTrackIds: string[];
  },
) {
  const candidateTrackIds = [
    input.seedTrackId ?? "",
    input.currentTrackId ?? "",
    ...input.favoriteClientTrackIds,
    ...input.historyClientTrackIds,
    ...sortFallbackSeedTrackIds(snapshot),
  ];

  return dedupe(candidateTrackIds.map((trackId) => snapshot.canonicalIdByVariantTrackId[trackId] ?? trackId)).filter(
    (trackId) => !!snapshot.tracksById[trackId],
  );
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
    const requestContext = await createRequestContext(prisma, userId);
    const favoriteTrackIds = new Set(requestContext.userState.favorites.map((favorite) => favorite.trackId));
    const trackByClientId = new Map(
      requestContext.userState.favorites
        .map((favorite) => favorite.track)
        .concat(requestContext.userState.historyEvents.map((event) => event.track))
        .map((track) => [toExternalTrackId(track), track] as const),
    );

    const context = buildBaseContext({
      snapshot: requestContext.snapshot,
      favoriteClientTrackIds: requestContext.favoriteClientTrackIds,
      historyClientTrackIds: requestContext.historyClientTrackIds,
      currentTrackId: input.currentTrackId ?? null,
      recentRecommendationTrackIds: input.recentRecommendationTrackIds ?? [],
      skippedTrackIds: input.skippedTrackIds ?? [],
      mode: input.mode ?? "autoplay",
    });

    const result = await requestContext.engine.getNextRecommendedTrack(context);
    if (!result) {
      return null;
    }

    const preferredTrack =
      trackByClientId.get(result.preferredVariantId) ??
      (await prisma.track.findFirst({
        where: {
          clientTrackId: result.preferredVariantId,
        },
      }));

    if (!preferredTrack) {
      return null;
    }

    return {
      canonicalTrackId: result.canonicalTrackId,
      preferredVariantId: result.preferredVariantId,
      score: result.score,
      sourceChannels: result.sourceChannels,
      explanation: result.explanation,
      track: serializeTrackForClient(preferredTrack, {
        isFavorite: favoriteTrackIds.has(preferredTrack.id),
      }),
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
    const requestContext = await createRequestContext(prisma, userId);
    const favoriteTrackIds = new Set(requestContext.userState.favorites.map((favorite) => favorite.trackId));
    const allTracks = await prisma.track.findMany();
    const trackByClientId = new Map(allTracks.map((track) => [toExternalTrackId(track), track] as const));
    const baseContext = buildBaseContext({
      snapshot: requestContext.snapshot,
      favoriteClientTrackIds: requestContext.favoriteClientTrackIds,
      historyClientTrackIds: requestContext.historyClientTrackIds,
      currentTrackId: input.currentTrackId ?? input.seedTrackId ?? null,
      recentRecommendationTrackIds: input.recentRecommendationTrackIds ?? [],
      skippedTrackIds: [],
      mode: input.mode ?? "autoplay",
    });
    const mode = input.mode ?? "autoplay";
    const seedCanonicalTrackIds = resolveSeedCanonicalTrackIds(requestContext.snapshot, {
      seedTrackId: input.seedTrackId ?? null,
      currentTrackId: input.currentTrackId ?? null,
      favoriteClientTrackIds: requestContext.favoriteClientTrackIds,
      historyClientTrackIds: requestContext.historyClientTrackIds,
    });
    const fallbackSeedCanonicalTrackId = seedCanonicalTrackIds[0] ?? null;
    const excludedIds = new Set(
      mapTrackIdsToCanonicalIds(requestContext.snapshot, input.excludeTrackIds ?? []),
    );
    const requestedLimit = input.limit ?? 12;
    const items: Array<ReturnType<typeof resolveRecommendedTrack>> = [];
    let effectiveSeedCanonicalTrackId = fallbackSeedCanonicalTrackId;

    for (const seedCanonicalTrackId of seedCanonicalTrackIds.slice(0, 8)) {
      const ranking = await requestContext.engine.getRecommendedTracks(
        {
          mode,
          canonicalTrackId: seedCanonicalTrackId,
        },
        buildSeededContext(
          requestContext.snapshot,
          baseContext,
          seedCanonicalTrackId,
          mode,
          dedupe([
            ...mapTrackIdsToCanonicalIds(requestContext.snapshot, input.recentRecommendationTrackIds ?? []),
            ...items
              .filter((item): item is NonNullable<typeof item> => !!item)
              .map((item) => item.canonicalTrackId),
          ]),
        ),
      );

      const nextItems = ranking
        .filter((track) => !excludedIds.has(track.canonicalTrackId))
        .map((track) =>
          resolveRecommendedTrack(requestContext.snapshot, track, favoriteTrackIds, trackByClientId),
        )
        .filter((track): track is NonNullable<typeof track> => !!track)
        .filter(
          (track) => !items.some((existingTrack) => existingTrack?.canonicalTrackId === track.canonicalTrackId),
        );

      if (nextItems.length > 0 && !effectiveSeedCanonicalTrackId) {
        effectiveSeedCanonicalTrackId = seedCanonicalTrackId;
      }

      items.push(...nextItems);

      if (items.length >= requestedLimit) {
        break;
      }
    }

    return {
      seed: {
        mode,
        canonicalTrackId: effectiveSeedCanonicalTrackId ?? undefined,
      },
      seedLabel: buildSeedLabel(
        requestContext.snapshot,
        effectiveSeedCanonicalTrackId ?? fallbackSeedCanonicalTrackId,
      ),
      items: items.slice(0, requestedLimit),
    };
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
    const requestContext = await createRequestContext(prisma, userId);
    const track = await ensureSyncTrack(prisma, input.trackId);
    const canonicalTrackId = requestContext.snapshot.canonicalIdByVariantTrackId[toExternalTrackId(track)];

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
      seedChannels: input.seedChannels?.length ? input.seedChannels : ["sessionContinuation"],
    };

    await requestContext.engine.updateAffinityFromPlayback(event);
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
    const requestContext = await createRequestContext(prisma, userId);
    const track = await ensureSyncTrack(prisma, input.trackId);
    const canonicalTrackId = requestContext.snapshot.canonicalIdByVariantTrackId[toExternalTrackId(track)];

    if (!canonicalTrackId) {
      return;
    }

    const event: FavoriteAffinityEvent = {
      canonicalTrackId,
      occurredAt: input.occurredAt,
      isFavorite: input.isFavorite,
    };

    await requestContext.engine.updateAffinityFromFavorite(event);
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
    const requestContext = await createRequestContext(prisma, userId);
    const track = await ensureSyncTrack(prisma, input.trackId);
    const canonicalTrackId = requestContext.snapshot.canonicalIdByVariantTrackId[toExternalTrackId(track)];

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
    const requestContext = await createRequestContext(prisma, userId);
    const track = await ensureSyncTrack(prisma, input.trackId);
    const canonicalTrackId = requestContext.snapshot.canonicalIdByVariantTrackId[toExternalTrackId(track)];

    if (!canonicalTrackId) {
      return;
    }

    const event: DislikeAffinityEvent = {
      canonicalTrackId,
      occurredAt: input.occurredAt,
      isDisliked: input.isDisliked,
    };

    await requestContext.engine.updateAffinityFromDislike(event);
    await logRecommendationEvent(prisma, userId, "DISLIKE", track.id, {
      ...event,
      trackId: input.trackId,
    });
  },
};
