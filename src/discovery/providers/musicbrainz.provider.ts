import type { ArtistLookup, DiscoveryProvider, ExternalArtist, ExternalRelease, ExternalTrack } from "./provider.types";
import { fetchJson } from "./providerUtils";

const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";

interface MusicBrainzTag {
  name?: string;
  count?: number;
}

interface MusicBrainzArtist {
  id?: string;
  name?: string;
  type?: string;
  country?: string;
  area?: { name?: string };
  tags?: MusicBrainzTag[];
}

interface MusicBrainzRecording {
  id?: string;
  title?: string;
  length?: number;
  "artist-credit"?: Array<{ artist?: MusicBrainzArtist; name?: string }>;
  releases?: Array<{
    id?: string;
    title?: string;
    date?: string;
    "release-group"?: { id?: string; type?: string };
  }>;
  isrcs?: string[];
  tags?: MusicBrainzTag[];
}

interface MusicBrainzRelease {
  id?: string;
  title?: string;
  date?: string;
  "release-group"?: { id?: string; type?: string };
  "artist-credit"?: Array<{ artist?: MusicBrainzArtist; name?: string }>;
}

function buildUrl(path: string, params: Record<string, string | number | undefined>) {
  const url = new URL(`${MUSICBRAINZ_BASE_URL}${path}`);
  Object.entries({ fmt: "json", ...params }).forEach(([key, value]) => {
    if (value !== undefined && `${value}`) {
      url.searchParams.set(key, `${value}`);
    }
  });
  return url.toString();
}

async function findArtist(input: ArtistLookup) {
  if (input.musicBrainzArtistId) {
    const artist = await fetchJson<MusicBrainzArtist>(
      buildUrl(`/artist/${encodeURIComponent(input.musicBrainzArtistId)}`, {
        inc: "tags+aliases",
      }),
    );
    if (artist?.id) {
      return artist;
    }
  }

  const name = input.name?.trim();
  if (!name) {
    return null;
  }

  const payload = await fetchJson<{ artists?: MusicBrainzArtist[] }>(
    buildUrl("/artist", {
      query: `artist:"${name.replace(/"/g, "")}"`,
      limit: 1,
    }),
  );
  return payload?.artists?.[0] ?? null;
}

function mapArtist(artist: MusicBrainzArtist | null): ExternalArtist | null {
  if (!artist?.id || !artist.name) {
    return null;
  }

  return {
    providerId: "musicbrainz",
    sourceArtistId: artist.id,
    name: artist.name,
    musicBrainzArtistId: artist.id,
    type: artist.type ?? null,
    country: artist.country ?? null,
    area: artist.area?.name ?? null,
    tags: (artist.tags ?? []).map((tag) => tag.name).filter((tag): tag is string => !!tag),
  };
}

function mapRecording(recording: MusicBrainzRecording): ExternalTrack | null {
  const artistCredit = recording["artist-credit"]?.[0];
  const artist = artistCredit?.artist;
  const artistName = artistCredit?.name ?? artist?.name;
  if (!recording.id || !recording.title || !artistName) {
    return null;
  }

  const release = recording.releases?.[0];
  return {
    providerId: "musicbrainz",
    sourceTrackId: recording.id,
    title: recording.title,
    artistName,
    albumTitle: release?.title ?? null,
    durationMs: typeof recording.length === "number" ? recording.length : null,
    musicBrainzRecordingId: recording.id,
    musicBrainzArtistId: artist?.id ?? null,
    musicBrainzReleaseId: release?.id ?? null,
    musicBrainzReleaseGroupId: release?.["release-group"]?.id ?? null,
    isrc: recording.isrcs?.[0] ?? null,
    releaseDate: release?.date ?? null,
    tags: (recording.tags ?? []).map((tag) => tag.name).filter((tag): tag is string => !!tag),
  };
}

function mapRelease(release: MusicBrainzRelease): ExternalRelease | null {
  if (!release.id || !release.title) {
    return null;
  }

  const releaseGroupType = release["release-group"]?.type?.toLowerCase();
  return {
    providerId: "musicbrainz",
    sourceReleaseId: release.id,
    title: release.title,
    artistName: release["artist-credit"]?.[0]?.name ?? release["artist-credit"]?.[0]?.artist?.name ?? null,
    musicBrainzReleaseId: release.id,
    musicBrainzReleaseGroupId: release["release-group"]?.id ?? null,
    kind: releaseGroupType === "album" ? "album" : releaseGroupType === "single" ? "single" : "other",
    date: release.date ?? null,
  };
}

export function createMusicBrainzProvider(): DiscoveryProvider {
  return {
    providerId: "musicbrainz",

    async getArtist(input) {
      return mapArtist(await findArtist(input));
    },

    async getArtistTopTracks(input, limit = 10) {
      const artist = await findArtist(input);
      if (!artist?.id && !input.name?.trim()) {
        return [];
      }

      const query = artist?.id ? `arid:${artist.id}` : `artist:"${input.name!.replace(/"/g, "")}"`;
      const payload = await fetchJson<{ recordings?: MusicBrainzRecording[] }>(
        buildUrl("/recording", {
          query,
          inc: "artist-credits+releases+isrcs+tags",
          limit,
        }),
      );

      return (payload?.recordings ?? []).map(mapRecording).filter((track): track is ExternalTrack => !!track);
    },

    async getArtistReleases(input, limit = 10) {
      const artist = await findArtist(input);
      if (!artist?.id && !input.name?.trim()) {
        return [];
      }

      const path = artist?.id ? "/release" : "/release";
      const payload = await fetchJson<{ releases?: MusicBrainzRelease[] }>(
        buildUrl(path, {
          artist: artist?.id,
          query: artist?.id ? undefined : `artist:"${input.name!.replace(/"/g, "")}"`,
          inc: "artist-credits+release-groups",
          limit,
        }),
      );

      return (payload?.releases ?? []).map(mapRelease).filter((release): release is ExternalRelease => !!release);
    },
  };
}
