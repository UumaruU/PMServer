import type { Artist, CanonicalTrack, PrismaClient } from "@prisma/client";

import type { DiscoveryProvider, ExternalArtist, ExternalArtistSimilarity, ExternalTrack } from "./providers/provider.types";
import { ingestArtist } from "./ingestion/ingestArtist";
import { ingestTrack } from "./ingestion/ingestTrack";
import { recommendationNormalizationService } from "../recommendation/canonical-graph/normalization";

const SIMILAR_PROVIDER_PRIORITY = ["lastfm", "deezer", "listenbrainz"];
const TRACK_PROVIDER_PRIORITY = ["lastfm", "deezer", "listenbrainz", "musicbrainz"];
const PLAYABLE_PROVIDER_PRIORITY = ["hitmos", "lmusic", "soundcloud"];
const FULL_PLAYABLE_PROVIDER_IDS = new Set(["hitmos", "lmusic", "soundcloud", "telegram"]);

function uniqueBy<T>(items: T[], getKey: (item: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];

  items.forEach((item) => {
    const key = getKey(item);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(item);
  });

  return result;
}

async function providerCall<T>(fallback: T, call: () => Promise<T>) {
  try {
    return await call();
  } catch {
    return fallback;
  }
}

function sortProviders(providers: DiscoveryProvider[], priority: string[]) {
  return [...providers].sort((left, right) => {
    const leftIndex = priority.indexOf(left.providerId);
    const rightIndex = priority.indexOf(right.providerId);
    const normalizedLeft = leftIndex >= 0 ? leftIndex : priority.length;
    const normalizedRight = rightIndex >= 0 ? rightIndex : priority.length;

    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }

    return left.providerId.localeCompare(right.providerId);
  });
}

function toComparableTrack(track: ExternalTrack) {
  const presentation = recommendationNormalizationService.normalizeTrackPresentation(track.title, track.artistName);

  return {
    titleCore: recommendationNormalizationService.normalizeTrackTitleCore(presentation.title),
    artistCore: recommendationNormalizationService.normalizeArtistCore(presentation.artist),
    durationMs:
      typeof track.durationMs === "number" && Number.isFinite(track.durationMs) && track.durationMs > 0
        ? Math.round(track.durationMs)
        : null,
  };
}

function scorePlayableVariantMatch(candidate: ExternalTrack, variant: ExternalTrack) {
  const left = toComparableTrack(candidate);
  const right = toComparableTrack(variant);
  let score = 0;

  if (left.titleCore && right.titleCore) {
    if (left.titleCore === right.titleCore) {
      score += 5;
    } else if (left.titleCore.includes(right.titleCore) || right.titleCore.includes(left.titleCore)) {
      score += 2;
    }
  }

  if (left.artistCore && right.artistCore) {
    if (left.artistCore === right.artistCore) {
      score += 4;
    } else if (left.artistCore.includes(right.artistCore) || right.artistCore.includes(left.artistCore)) {
      score += 2;
    }
  }

  if (left.durationMs && right.durationMs) {
    const delta = Math.abs(left.durationMs - right.durationMs);
    if (delta <= 4_000) {
      score += 3;
    } else if (delta <= 9_000) {
      score += 2;
    } else if (delta <= 15_000) {
      score += 1;
    } else {
      score -= 3;
    }
  }

  if (variant.providerId === "hitmos" || variant.providerId === "lmusic") {
    score += 0.5;
  }

  return score;
}

function filterPlayableVariants(candidate: ExternalTrack, variants: ExternalTrack[]) {
  return variants
    .filter((variant) => FULL_PLAYABLE_PROVIDER_IDS.has(variant.providerId) && !!variant.audioUrl)
    .map((variant) => ({
      variant,
      score: scorePlayableVariantMatch(candidate, variant),
    }))
    .filter(({ score }) => score >= 7)
    .sort((left, right) => right.score - left.score)
    .map(({ variant }) => variant);
}

async function resolvePlayableVariants(params: {
  providers: DiscoveryProvider[];
  track: ExternalTrack;
  maxCalls: number;
}) {
  const query = `${params.track.artistName} ${params.track.title}`.trim();
  const searchableProviders = sortProviders(
    params.providers.filter((provider) => !!provider.searchTracks),
    PLAYABLE_PROVIDER_PRIORITY,
  );
  const results: ExternalTrack[] = [];
  let calls = 0;

  for (const provider of searchableProviders) {
    if (calls >= params.maxCalls) {
      break;
    }

    calls += 1;
    const tracks = await providerCall([], () => provider.searchTracks!(query, 3));
    results.push(...tracks);
  }

  return {
    tracks: filterPlayableVariants(
      params.track,
      uniqueBy(results, (track) => `${track.providerId}:${track.sourceTrackId}`),
    ),
    calls,
  };
}

async function enrichArtistFromCanonicalProvider(params: {
  providers: DiscoveryProvider[];
  artist: ExternalArtistSimilarity;
}) {
  const provider = sortProviders(
    params.providers.filter((entry) => entry.providerId === "musicbrainz" && !!entry.getArtist),
    ["musicbrainz"],
  )[0];
  if (!provider?.getArtist) {
    return params.artist;
  }

  const enriched = await providerCall<ExternalArtist | null>(null, () =>
    provider.getArtist!({
      musicBrainzArtistId: params.artist.musicBrainzArtistId,
      name: params.artist.name,
    }),
  );
  if (!enriched) {
    return params.artist;
  }

  return {
    ...params.artist,
    ...enriched,
    providerId: params.artist.providerId,
    sourceArtistId: params.artist.sourceArtistId ?? enriched.sourceArtistId,
    musicBrainzArtistId: enriched.musicBrainzArtistId ?? params.artist.musicBrainzArtistId ?? null,
    tags: [...new Set([...(enriched.tags ?? []), ...(params.artist.tags ?? [])])],
  } satisfies ExternalArtistSimilarity;
}

export async function expandFromCanonicalTrack(params: {
  prisma: PrismaClient;
  providers: DiscoveryProvider[];
  seedTrack: CanonicalTrack & { artists: Artist[] };
  providerCallLimit?: number;
  discoveredFrom: string;
}) {
  const primaryArtist = params.seedTrack.artists[0];
  if (!primaryArtist) {
    return {
      ingestedTrackIds: [],
      providerCalls: 0,
    };
  }

  let providerCalls = 0;
  const maxProviderCalls = params.providerCallLimit ?? Number.POSITIVE_INFINITY;
  const liveMode = Number.isFinite(maxProviderCalls);
  const similarArtists: ExternalArtistSimilarity[] = [];
  const similarityProviders = sortProviders(
    params.providers.filter((provider) => !!provider.getSimilarArtists),
    SIMILAR_PROVIDER_PRIORITY,
  );

  for (const provider of similarityProviders) {
    if (providerCalls >= maxProviderCalls) {
      break;
    }

    providerCalls += 1;
    similarArtists.push(
      ...(await providerCall([], () =>
        provider.getSimilarArtists!(
          {
            artistId: primaryArtist.id,
            musicBrainzArtistId: primaryArtist.musicBrainzArtistId,
            name: primaryArtist.name,
          },
          5,
        ),
      )),
    );

    if (liveMode && similarArtists.length) {
      break;
    }
  }

  const ingestedTrackIds: string[] = [];
  const liveSimilarArtistLimit = liveMode ? Math.min(3, Math.max(1, Math.floor(maxProviderCalls / 3))) : 4;
  const topSimilarArtists = uniqueBy(similarArtists, (artist) => artist.musicBrainzArtistId ?? artist.name)
    .sort((left, right) => right.score - left.score)
    .slice(0, liveSimilarArtistLimit);

  for (const similarArtist of topSimilarArtists) {
    const enrichedSimilarArtist = liveMode
      ? similarArtist
      : await enrichArtistFromCanonicalProvider({
          providers: params.providers,
          artist: similarArtist,
        });
    if (!liveMode && enrichedSimilarArtist !== similarArtist) {
      providerCalls += 1;
    }

    const artist = await ingestArtist(params.prisma, enrichedSimilarArtist);
    await params.prisma.artistSimilarity.upsert({
      where: {
        sourceArtistId_targetArtistId_providerId: {
          sourceArtistId: primaryArtist.id,
          targetArtistId: artist.id,
          providerId: enrichedSimilarArtist.providerId,
        },
      },
      create: {
        sourceArtistId: primaryArtist.id,
        targetArtistId: artist.id,
        providerId: enrichedSimilarArtist.providerId,
        score: enrichedSimilarArtist.score,
        confidence: enrichedSimilarArtist.confidence ?? 0.62,
        reason: enrichedSimilarArtist.reason ?? "similar-artist",
      },
      update: {
        score: enrichedSimilarArtist.score,
        confidence: enrichedSimilarArtist.confidence ?? 0.62,
        reason: enrichedSimilarArtist.reason ?? "similar-artist",
      },
    });

    const trackCandidates: ExternalTrack[] = [];
    for (const provider of sortProviders(
      params.providers.filter((entry) => !!entry.getArtistTopTracks),
      TRACK_PROVIDER_PRIORITY,
    )) {
      if (providerCalls >= (liveMode ? Math.max(0, maxProviderCalls - 1) : maxProviderCalls)) {
        break;
      }

      providerCalls += 1;
      trackCandidates.push(
        ...(await providerCall([], () =>
          provider.getArtistTopTracks!(
            {
              artistId: artist.id,
              musicBrainzArtistId: artist.musicBrainzArtistId,
              name: artist.name,
            },
            5,
          ),
        )),
      );

      if (liveMode && trackCandidates.length) {
        break;
      }
    }

    for (const candidate of uniqueBy(trackCandidates, (track) => `${track.providerId}:${track.sourceTrackId}`).slice(0, liveMode ? 2 : 5)) {
      const remainingPlayableCalls = Math.max(0, maxProviderCalls - providerCalls);
      const playableVariants = await resolvePlayableVariants({
        providers: params.providers,
        track: candidate,
        maxCalls: liveMode ? remainingPlayableCalls : Number.POSITIVE_INFINITY,
      });
      providerCalls += playableVariants.calls;
      const variants = playableVariants.tracks.length
        ? playableVariants.tracks
        : candidate.audioUrl && FULL_PLAYABLE_PROVIDER_IDS.has(candidate.providerId)
          ? [candidate]
          : [];
      if (!variants.length) {
        continue;
      }

      for (const variant of variants) {
        const ingested = await ingestTrack(params.prisma, {
          track: {
            ...candidate,
            ...variant,
            musicBrainzArtistId: variant.musicBrainzArtistId ?? candidate.musicBrainzArtistId ?? artist.musicBrainzArtistId,
            tags: [...new Set([...(candidate.tags ?? []), ...(variant.tags ?? []), ...artist.tags])],
          },
          discoveredFrom: params.discoveredFrom,
        });
        ingestedTrackIds.push(ingested.canonicalTrack.id);
        await params.prisma.trackEdge.upsert({
          where: {
            sourceTrackId_targetTrackId_artistId_edgeType: {
              sourceTrackId: params.seedTrack.id,
              targetTrackId: ingested.canonicalTrack.id,
              artistId: artist.id,
              edgeType: "related_artist_track",
            },
          },
          create: {
            sourceTrackId: params.seedTrack.id,
            targetTrackId: ingested.canonicalTrack.id,
            artistId: artist.id,
            edgeType: "related_artist_track",
            providerId: variant.providerId,
            weight: enrichedSimilarArtist.score,
            confidence: enrichedSimilarArtist.confidence ?? 0.62,
            reason: params.discoveredFrom,
          },
          update: {
            providerId: variant.providerId,
            weight: enrichedSimilarArtist.score,
            confidence: enrichedSimilarArtist.confidence ?? 0.62,
            reason: params.discoveredFrom,
          },
        });
      }
    }
  }

  return {
    ingestedTrackIds: [...new Set(ingestedTrackIds)],
    providerCalls,
  };
}
