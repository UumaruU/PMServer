import type { ArtistLookup, DiscoveryProvider, ExternalArtistSimilarity, ExternalTrack } from "./provider.types";
import { fetchJson } from "./providerUtils";

type ListenBrainzSimilarArtist =
  | string
  | {
      artist_mbid?: string;
      artist_name?: string;
      name?: string;
      score?: number;
      similarity?: number;
    };

type ListenBrainzRecording =
  | string
  | {
      recording_mbid?: string;
      recording_name?: string;
      track_name?: string;
      artist_name?: string;
      artist_mbid?: string;
      score?: number;
    };

function getItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.similar_artists,
    record.artists,
    record.payload && typeof record.payload === "object" ? (record.payload as Record<string, unknown>).artists : undefined,
    record.recordings,
    record.recommendations,
  ];
  return (candidates.find(Array.isArray) as T[] | undefined) ?? [];
}

async function callAny<T>(baseUrl: string, paths: string[]) {
  for (const path of paths) {
    const payload = await fetchJson<T>(`${baseUrl}${path}`);
    if (payload) {
      return payload;
    }
  }

  return null;
}

export function createListenBrainzProvider(baseUrl = "https://api.listenbrainz.org/1"): DiscoveryProvider {
  return {
    providerId: "listenbrainz",

    async getSimilarArtists(input: ArtistLookup, limit = 12) {
      const mbid = input.musicBrainzArtistId?.trim();
      if (!mbid) {
        return [];
      }

      const payload = await callAny<unknown>(baseUrl, [
        `/metadata/artist/${encodeURIComponent(mbid)}/similar?limit=${limit}`,
        `/artist/${encodeURIComponent(mbid)}/similar-artists?limit=${limit}`,
        `/similar-artists/${encodeURIComponent(mbid)}?limit=${limit}`,
      ]);

      return getItems<ListenBrainzSimilarArtist>(payload)
        .map<ExternalArtistSimilarity | null>((artist) => {
          if (typeof artist === "string") {
            return {
              providerId: "listenbrainz",
              sourceArtistId: artist,
              musicBrainzArtistId: artist,
              name: artist,
              score: 0.62,
              confidence: 0.45,
              reason: "listenbrainz-artist-graph",
            };
          }

          const name = artist.artist_name ?? artist.name ?? artist.artist_mbid;
          if (!name) {
            return null;
          }

          return {
            providerId: "listenbrainz",
            sourceArtistId: artist.artist_mbid ?? name,
            musicBrainzArtistId: artist.artist_mbid ?? null,
            name,
            score: artist.score ?? artist.similarity ?? 0.62,
            confidence: artist.artist_mbid ? 0.7 : 0.48,
            reason: "listenbrainz-artist-graph",
          };
        })
        .filter((artist): artist is ExternalArtistSimilarity => !!artist)
        .slice(0, limit);
    },

    async getArtistTopTracks(input: ArtistLookup, limit = 10) {
      const mbid = input.musicBrainzArtistId?.trim();
      if (!mbid) {
        return [];
      }

      const payload = await callAny<unknown>(baseUrl, [
        `/metadata/artist/${encodeURIComponent(mbid)}/recordings?limit=${limit}`,
        `/artist/${encodeURIComponent(mbid)}/recordings?limit=${limit}`,
      ]);

      return getItems<ListenBrainzRecording>(payload)
        .map<ExternalTrack | null>((recording) => {
          if (typeof recording === "string") {
            return null;
          }

          const title = recording.recording_name ?? recording.track_name;
          const artistName = recording.artist_name ?? input.name;
          if (!title || !artistName) {
            return null;
          }

          return {
            providerId: "listenbrainz",
            sourceTrackId: recording.recording_mbid ?? `${artistName}:${title}`,
            title,
            artistName,
            musicBrainzRecordingId: recording.recording_mbid ?? null,
            musicBrainzArtistId: recording.artist_mbid ?? mbid,
          };
        })
        .filter((track): track is ExternalTrack => !!track)
        .slice(0, limit);
    },
  };
}
