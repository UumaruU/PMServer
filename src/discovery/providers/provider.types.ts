export interface ArtistLookup {
  artistId?: string | null;
  musicBrainzArtistId?: string | null;
  name?: string | null;
}

export interface ExternalArtist {
  providerId: string;
  sourceArtistId?: string | null;
  name: string;
  musicBrainzArtistId?: string | null;
  type?: string | null;
  country?: string | null;
  area?: string | null;
  imageUrl?: string | null;
  tags?: string[];
}

export interface ExternalArtistSimilarity extends ExternalArtist {
  score: number;
  confidence?: number;
  reason?: string;
}

export interface ExternalTrack {
  providerId: string;
  sourceTrackId: string;
  title: string;
  artistName: string;
  albumTitle?: string | null;
  durationMs?: number | null;
  coverUrl?: string | null;
  audioUrl?: string | null;
  sourceUrl?: string | null;
  musicBrainzRecordingId?: string | null;
  musicBrainzArtistId?: string | null;
  musicBrainzReleaseId?: string | null;
  musicBrainzReleaseGroupId?: string | null;
  isrc?: string | null;
  releaseDate?: string | null;
  tags?: string[];
}

export interface ExternalRelease {
  providerId: string;
  sourceReleaseId?: string | null;
  title: string;
  artistName?: string | null;
  musicBrainzReleaseId?: string | null;
  musicBrainzReleaseGroupId?: string | null;
  kind?: "album" | "single" | "other";
  date?: string | null;
  coverUrl?: string | null;
  trackTitles?: string[];
}

export interface DiscoveryProvider {
  providerId: string;
  searchTracks?(query: string, limit?: number): Promise<ExternalTrack[]>;
  getArtist?(input: ArtistLookup): Promise<ExternalArtist | null>;
  getSimilarArtists?(input: ArtistLookup, limit?: number): Promise<ExternalArtistSimilarity[]>;
  getArtistTopTracks?(input: ArtistLookup, limit?: number): Promise<ExternalTrack[]>;
  getArtistReleases?(input: ArtistLookup, limit?: number): Promise<ExternalRelease[]>;
  getTagTopTracks?(tag: string, limit?: number): Promise<ExternalTrack[]>;
}
