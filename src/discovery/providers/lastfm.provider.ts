import type {
  ArtistLookup,
  DiscoveryProvider,
  ExternalArtist,
  ExternalArtistSimilarity,
  ExternalTrack,
} from "./provider.types";

interface LastfmArtistMatch {
  name?: string;
  mbid?: string;
  match?: string;
}

interface LastfmTopTrack {
  name?: string;
  artist?: { name?: string; mbid?: string };
  duration?: string;
  mbid?: string;
}

interface LastfmImage {
  "#text"?: string;
  size?: string;
}

interface LastfmTag {
  name?: string;
}

interface LastfmArtistInfo {
  name?: string;
  mbid?: string;
  url?: string;
  image?: LastfmImage[];
  tags?: { tag?: LastfmTag[] };
  bio?: { placeformed?: string };
}

function pickLargestImage(images?: LastfmImage[]) {
  return [...(images ?? [])].reverse().find((image) => image["#text"])?.["#text"] ?? null;
}

export function createLastfmProvider(apiKey?: string | null): DiscoveryProvider | null {
  if (!apiKey) {
    return null;
  }

  const call = async <T>(params: Record<string, string | number | undefined>): Promise<T | null> => {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    Object.entries({
      ...params,
      api_key: apiKey,
      format: "json",
    }).forEach(([key, value]) => {
      if (value !== undefined && `${value}`) {
        url.searchParams.set(key, `${value}`);
      }
    });

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }

      return (await response.json()) as T;
    } catch {
      return null;
    }
  };

  const artistName = (input: ArtistLookup) => input.name?.trim() || undefined;

  return {
    providerId: "lastfm",

    async getArtist(input) {
      const name = artistName(input);
      if (!name) {
        return null;
      }

      const payload = await call<{ artist?: LastfmArtistInfo }>({
        method: "artist.getinfo",
        artist: name,
        mbid: input.musicBrainzArtistId ?? undefined,
        autocorrect: 1,
      });
      const artist = payload?.artist;
      if (!artist?.name) {
        return null;
      }

      return {
        providerId: "lastfm",
        sourceArtistId: artist.mbid || artist.name,
        name: artist.name,
        musicBrainzArtistId: artist.mbid || input.musicBrainzArtistId || null,
        area: artist.bio?.placeformed ?? null,
        imageUrl: pickLargestImage(artist.image),
        tags: (artist.tags?.tag ?? []).map((tag) => tag.name).filter((tag): tag is string => !!tag),
      } satisfies ExternalArtist;
    },

    async getSimilarArtists(input, limit = 12) {
      const name = artistName(input);
      if (!name) {
        return [];
      }

      const payload = await call<{ similarartists?: { artist?: LastfmArtistMatch[] } }>({
        method: "artist.getsimilar",
        artist: name,
        limit,
      });

      return (payload?.similarartists?.artist ?? [])
        .map<ExternalArtistSimilarity | null>((artist) => {
          if (!artist.name) {
            return null;
          }

          return {
            providerId: "lastfm",
            sourceArtistId: artist.mbid || artist.name,
            name: artist.name,
            musicBrainzArtistId: artist.mbid || null,
            score: Number(artist.match ?? 0.5) || 0.5,
            confidence: artist.mbid ? 0.82 : 0.62,
            reason: "lastfm-similar-artist",
          };
        })
        .filter((artist): artist is ExternalArtistSimilarity => !!artist);
    },

    async getArtistTopTracks(input, limit = 10) {
      const name = artistName(input);
      if (!name) {
        return [];
      }

      const payload = await call<{ toptracks?: { track?: LastfmTopTrack[] } }>({
        method: "artist.gettoptracks",
        artist: name,
        limit,
      });

      return (payload?.toptracks?.track ?? [])
        .map<ExternalTrack | null>((track) => {
          if (!track.name || !track.artist?.name) {
            return null;
          }

          const durationSeconds = Number(track.duration);
          return {
            providerId: "lastfm",
            sourceTrackId: track.mbid || `${track.artist.name}:${track.name}`,
            title: track.name,
            artistName: track.artist.name,
            durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : null,
            musicBrainzRecordingId: track.mbid || null,
            musicBrainzArtistId: track.artist.mbid || null,
          };
        })
        .filter((track): track is ExternalTrack => !!track);
    },

    async getTagTopTracks(tag, limit = 10) {
      const normalizedTag = tag.trim();
      if (!normalizedTag) {
        return [];
      }

      const payload = await call<{ tracks?: { track?: LastfmTopTrack[] } }>({
        method: "tag.gettoptracks",
        tag: normalizedTag,
        limit,
      });

      return (payload?.tracks?.track ?? [])
        .map<ExternalTrack | null>((track) => {
          if (!track.name || !track.artist?.name) {
            return null;
          }

          const durationSeconds = Number(track.duration);
          return {
            providerId: "lastfm",
            sourceTrackId: track.mbid || `${track.artist.name}:${track.name}`,
            title: track.name,
            artistName: track.artist.name,
            durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : null,
            musicBrainzRecordingId: track.mbid || null,
            musicBrainzArtistId: track.artist.mbid || null,
            tags: [normalizedTag],
          };
        })
        .filter((track): track is ExternalTrack => !!track);
    },
  };
}
