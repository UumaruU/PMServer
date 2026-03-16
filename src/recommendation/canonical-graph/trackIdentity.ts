import { normalizeCoverUrl } from "./coverUrl";
import { normalizeTrackPresentation } from "./normalization";
import { withSourceMetadata } from "./sourceMetadata";
import { RecommendationProviderId, RecommendationSourceTrack } from "../types";

export const DEFAULT_PROVIDER_ID: RecommendationProviderId = "hitmos";

export function withTrackProviderDefaults(track: RecommendationSourceTrack): RecommendationSourceTrack {
  const normalizedPresentation = normalizeTrackPresentation(track.title, track.artist);

  return withSourceMetadata({
    ...track,
    providerId: track.providerId ?? DEFAULT_PROVIDER_ID,
    providerTrackId: track.providerTrackId ?? track.id,
    title: normalizedPresentation.title || track.title,
    artist: normalizedPresentation.artist || track.artist,
    coverUrl: normalizeCoverUrl(track.coverUrl) || track.coverUrl,
  });
}

export function normalizeTracks<T extends RecommendationSourceTrack>(tracks: T[]) {
  return tracks.map((track) => withTrackProviderDefaults(track) as T);
}

export function getProviderTrackId(track: Pick<RecommendationSourceTrack, "id" | "providerTrackId">) {
  return track.providerTrackId ?? track.id;
}
