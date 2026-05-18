import type { CanonicalTrack, TrackSource } from "@prisma/client";

import type { ExternalTrack } from "./providers/provider.types";

export type DiscoverySeedReason =
  | "favorite"
  | "favorite_artist"
  | "favorite_tag"
  | "playback"
  | "playback_artist"
  | "playlist"
  | "playlist_artist"
  | "liked_artist"
  | "liked_track"
  | "completed_listen"
  | "playlist_track"
  | "opened_artist"
  | "user_top_tag"
  | "similar_artist"
  | "adjacent_genre"
  | "trending_artist_by_genre"
  | "new_release"
  | "collaborator_feature"
  | "popular_artist_by_genre"
  | "top_track_by_tag"
  | "trending_artist"
  | "country_language_chart"
  | "long_tail_active_scene";

export type DiscoveryJobType =
  | "enrich_track_metadata"
  | "resolve_artist"
  | "find_similar_artists"
  | "fetch_artist_top_tracks"
  | "fetch_related_artist_top_tracks"
  | "fetch_artist_latest_releases"
  | "find_tag_top_tracks"
  | "resolve_playable_variants"
  | "update_track_edges"
  | "update_artist_similarity"
  | "refresh_artist_metadata"
  | "refresh_latest_releases"
  | "refresh_playable_sources"
  | "refresh_similarity_edges"
  | "rebuild_user_clusters"
  | "recalculate_popularity"
  | "cleanup_duplicates";

export interface DiscoveryContext {
  mode?: string;
  currentCanonicalTrackId?: string | null;
  favoritedTrackIds?: string[];
  recentTrackIds?: string[];
  userFeatures?: {
    topArtists?: Array<{ id: string; score: number }>;
    topTags?: Array<{ id: string; score: number }>;
  } | null;
}

export interface NormalizedExternalTrack extends ExternalTrack {
  title: string;
  artistName: string;
  normalizedTitle: string;
  normalizedArtist: string;
  normalizedTitleCore: string;
  normalizedArtistCore: string;
  titleFlavor: string[];
  durationMs: number | null;
  tags: string[];
  qualityScore: number;
  matchConfidence: number;
  isPlayable: boolean;
}

export interface IngestedTrack {
  canonicalTrack: CanonicalTrack;
  source: TrackSource;
}
