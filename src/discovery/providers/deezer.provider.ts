import type {
  ArtistLookup,
  DiscoveryProvider,
  ExternalArtist,
  ExternalArtistSimilarity,
  ExternalRelease,
  ExternalTrack,
} from "./provider.types";
import { fetchJson } from "./providerUtils";

interface DeezerTrack {
  id: number;
  title?: string;
  duration?: number;
  link?: string;
  preview?: string;
  artist?: { id?: number; name?: string };
  album?: { title?: string; cover_xl?: string; cover_big?: string };
}

interface DeezerArtist {
  id: number;
  name?: string;
  link?: string;
  picture_xl?: string;
  picture_big?: string;
  type?: string;
}

interface DeezerAlbum {
  id: number;
  title?: string;
  link?: string;
  cover_xl?: string;
  cover_big?: string;
  release_date?: string;
  record_type?: string;
}

export function createDeezerProvider(baseUrl = "https://api.deezer.com"): DiscoveryProvider {
  const call = async <T>(path: string): Promise<T | null> => {
    return fetchJson<T>(`${baseUrl}${path}`);
  };

  const searchArtistId = async (input: ArtistLookup) => {
    const name = input.name?.trim();
    if (!name) {
      return null;
    }

    const payload = await call<{ data?: DeezerArtist[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=1`);
    return payload?.data?.[0]?.id ?? null;
  };

  const mapTrack = (track: DeezerTrack): ExternalTrack | null => {
    if (!track.title || !track.artist?.name) {
      return null;
    }

    return {
      providerId: "deezer",
      sourceTrackId: `${track.id}`,
      title: track.title,
      artistName: track.artist.name,
      albumTitle: track.album?.title ?? null,
      durationMs: typeof track.duration === "number" ? track.duration * 1000 : null,
      coverUrl: track.album?.cover_xl ?? track.album?.cover_big ?? null,
      audioUrl: track.preview || null,
      sourceUrl: track.link ?? null,
    };
  };

  return {
    providerId: "deezer",

    async searchTracks(query, limit = 5) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return [];
      }

      const payload = await call<{ data?: DeezerTrack[] }>(
        `/search?q=${encodeURIComponent(normalizedQuery)}&limit=${limit}`,
      );
      return (payload?.data ?? []).map(mapTrack).filter((track): track is ExternalTrack => !!track);
    },

    async getArtist(input) {
      const artistId = await searchArtistId(input);
      if (!artistId) {
        return null;
      }

      const artist = await call<DeezerArtist>(`/artist/${artistId}`);
      if (!artist?.name) {
        return null;
      }

      return {
        providerId: "deezer",
        sourceArtistId: `${artist.id}`,
        name: artist.name,
        imageUrl: artist.picture_xl ?? artist.picture_big ?? null,
        type: artist.type ?? null,
      } satisfies ExternalArtist;
    },

    async getSimilarArtists(input, limit = 12) {
      const artistId = await searchArtistId(input);
      if (!artistId) {
        return [];
      }

      const payload = await call<{ data?: DeezerArtist[] }>(`/artist/${artistId}/related?limit=${limit}`);
      return (payload?.data ?? [])
        .map<ExternalArtistSimilarity | null>((artist) =>
          artist.name
            ? {
                providerId: "deezer",
                sourceArtistId: `${artist.id}`,
                name: artist.name,
                imageUrl: artist.picture_xl ?? null,
                score: 0.78,
                confidence: 0.66,
                reason: "deezer-related-artist",
              }
            : null,
        )
        .filter((artist): artist is ExternalArtistSimilarity => !!artist);
    },

    async getArtistTopTracks(input, limit = 10) {
      const artistId = await searchArtistId(input);
      if (!artistId) {
        return [];
      }

      const payload = await call<{ data?: DeezerTrack[] }>(`/artist/${artistId}/top?limit=${limit}`);
      return (payload?.data ?? []).map(mapTrack).filter((track): track is ExternalTrack => !!track);
    },

    async getArtistReleases(input, limit = 8) {
      const artistId = await searchArtistId(input);
      if (!artistId) {
        return [];
      }

      const payload = await call<{ data?: DeezerAlbum[] }>(`/artist/${artistId}/albums?limit=${limit}`);
      return (payload?.data ?? [])
        .map<ExternalRelease | null>((album) => {
          if (!album.title) {
            return null;
          }

          return {
            providerId: "deezer",
            sourceReleaseId: `${album.id}`,
            title: album.title,
            artistName: input.name ?? null,
            kind: album.record_type === "single" ? "single" : album.record_type === "album" ? "album" : "other",
            date: album.release_date ?? null,
            coverUrl: album.cover_xl ?? album.cover_big ?? null,
          };
        })
        .filter((release): release is ExternalRelease => !!release);
    },
  };
}
