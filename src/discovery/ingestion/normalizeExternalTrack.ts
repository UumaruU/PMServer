import { recommendationNormalizationService } from "../../recommendation/canonical-graph/normalization";
import type { ExternalTrack } from "../providers/provider.types";
import type { NormalizedExternalTrack } from "../discovery.types";

function normalizeOptional(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function buildQualityScore(track: ExternalTrack, isPlayable: boolean) {
  let score = 0.38;

  if (track.musicBrainzRecordingId) {
    score += 0.25;
  }

  if (track.musicBrainzArtistId) {
    score += 0.12;
  }

  if (track.albumTitle || track.musicBrainzReleaseId) {
    score += 0.08;
  }

  if (isPlayable) {
    score += 0.12;
  }

  if (track.coverUrl) {
    score += 0.03;
  }

  return clamp01(score);
}

function looksLikeLowQualityTitle(value: string) {
  return /\b(?:karaoke|reaction|podcast)\b/i.test(value);
}

function isFullPlayableProvider(providerId: string) {
  return providerId !== "deezer";
}

export function normalizeExternalTrack(track: ExternalTrack): NormalizedExternalTrack | null {
  const title = normalizeOptional(track.title);
  const artistName = normalizeOptional(track.artistName);
  const sourceTrackId = normalizeOptional(track.sourceTrackId);
  const providerId = normalizeOptional(track.providerId);

  if (!title || !artistName || !sourceTrackId || !providerId) {
    return null;
  }

  const durationMs =
    typeof track.durationMs === "number" && Number.isFinite(track.durationMs)
      ? Math.max(0, Math.round(track.durationMs))
      : null;

  if (durationMs !== null && durationMs > 0 && durationMs < 30_000) {
    return null;
  }

  if (durationMs !== null && durationMs > 30 * 60_000 && !/\b(?:mix|set|live)\b/i.test(title)) {
    return null;
  }

  const normalized = recommendationNormalizationService.normalizeTrackForCanonicalization({
    id: `${providerId}:${sourceTrackId}`,
    providerId,
    providerTrackId: sourceTrackId,
    title,
    artist: artistName,
    coverUrl: track.coverUrl ?? "",
    audioUrl: track.audioUrl ?? "",
    duration: durationMs ?? 0,
    sourceUrl: track.sourceUrl ?? "",
    isFavorite: false,
  });
  const isPlayable = isFullPlayableProvider(providerId) && !!normalizeOptional(track.audioUrl);
  const qualityScore = buildQualityScore(track, isPlayable) - (looksLikeLowQualityTitle(title) ? 0.25 : 0);

  return {
    ...track,
    providerId,
    sourceTrackId,
    title,
    artistName,
    albumTitle: normalizeOptional(track.albumTitle),
    durationMs,
    coverUrl: normalizeOptional(track.coverUrl),
    audioUrl: normalizeOptional(track.audioUrl),
    sourceUrl: normalizeOptional(track.sourceUrl),
    musicBrainzRecordingId: normalizeOptional(track.musicBrainzRecordingId),
    musicBrainzArtistId: normalizeOptional(track.musicBrainzArtistId),
    musicBrainzReleaseId: normalizeOptional(track.musicBrainzReleaseId),
    musicBrainzReleaseGroupId: normalizeOptional(track.musicBrainzReleaseGroupId),
    isrc: normalizeOptional(track.isrc),
    releaseDate: normalizeOptional(track.releaseDate),
    tags: [...new Set((track.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    normalizedTitle: recommendationNormalizationService.normalizeTrackTitle(title),
    normalizedArtist: recommendationNormalizationService.normalizeArtistName(artistName),
    normalizedTitleCore: normalized.normalizedTitleCore,
    normalizedArtistCore: normalized.normalizedArtistCore,
    titleFlavor: normalized.titleFlavor,
    qualityScore: clamp01(qualityScore),
    matchConfidence: track.musicBrainzRecordingId || track.isrc ? 0.96 : 0.62,
    isPlayable,
  };
}
