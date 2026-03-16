import type { Track } from "@prisma/client";

import {
  getProviderIdForClientTrack,
  getProviderTrackIdForClientTrack,
  toExternalTrackId,
} from "./service";

const FALLBACK_COVER_URL = "https://placehold.co/300x300?text=Pingu+Music";

// Backend adapter: serializes DB tracks into the frontend-facing track shape.
export function serializeTrackForClient(track: Track, options: { isFavorite?: boolean } = {}) {
  const providerId = getProviderIdForClientTrack(track);

  return {
    id: toExternalTrackId(track),
    providerId,
    providerTrackId: getProviderTrackIdForClientTrack(track),
    title: track.title,
    artist: track.artistName,
    coverUrl: track.coverUrl ?? FALLBACK_COVER_URL,
    audioUrl: track.audioUrl ?? "",
    duration: track.duration ?? 0,
    sourceUrl:
      providerId === "hitmos"
        ? "https://rus.hitmotop.com"
        : track.audioUrl ?? `https://example.invalid/tracks/${encodeURIComponent(track.sourceTrackId)}`,
    isFavorite: options.isFavorite ?? false,
    downloadState: "idle" as const,
    metadataStatus: track.musicBrainzRecordingId || track.musicBrainzArtistId || track.musicBrainzReleaseId
      ? ("enriched" as const)
      : ("raw" as const),
    albumTitle: track.albumTitle ?? undefined,
    musicBrainzRecordingId: track.musicBrainzRecordingId ?? undefined,
    musicBrainzArtistId: track.musicBrainzArtistId ?? undefined,
    musicBrainzReleaseId: track.musicBrainzReleaseId ?? undefined,
  };
}
