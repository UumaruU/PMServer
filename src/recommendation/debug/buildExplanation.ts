import { RecommendationExplanation, RecommendationCatalogSnapshot } from "../types";

// Pure domain logic: explainability payload is deterministic for a fixed ranking order.
export function buildExplanation(params: {
  candidate: {
    canonicalTrackId: string;
    sourceChannels: string[];
    scoreBreakdown: RecommendationExplanation["scoreBreakdown"];
    penaltiesApplied: RecommendationExplanation["penaltiesApplied"];
    __track: RecommendationCatalogSnapshot["tracksById"][string];
  };
  snapshot: RecommendationCatalogSnapshot;
  suppressedCompetitors: Array<{ canonicalTrackId: string; finalScore: number }>;
}) {
  const track = params.candidate.__track;
  const relevantArtists = track.canonicalArtistIds
    .map((artistId) => params.snapshot.artistsById[artistId]?.name)
    .filter((value): value is string => !!value)
    .sort((left, right) => left.localeCompare(right));
  const relevantTags = track.tagIds
    .map((tagId) => params.snapshot.tagsById[tagId]?.displayName ?? tagId)
    .sort((left, right) => left.localeCompare(right));
  const topReasons = [
    ...params.candidate.sourceChannels.map((channel) => `channel:${channel}`),
    track.primaryCanonicalArtistId ? `artist:${params.snapshot.artistsById[track.primaryCanonicalArtistId]?.name ?? track.primaryCanonicalArtistId}` : null,
    track.canonicalReleaseId ? `release:${params.snapshot.releasesById[track.canonicalReleaseId]?.title ?? track.canonicalReleaseId}` : null,
    relevantTags[0] ? `tag:${relevantTags[0]}` : null,
  ].filter((value): value is string => !!value);

  return {
    canonicalTrackId: track.canonicalTrackId,
    preferredVariantId: track.preferredVariantId ?? "",
    sourceChannels: params.candidate.sourceChannels as RecommendationExplanation["sourceChannels"],
    scoreBreakdown: params.candidate.scoreBreakdown,
    topReasons,
    penaltiesApplied: params.candidate.penaltiesApplied,
    suppressedCompetitors: params.suppressedCompetitors,
    relevantTags,
    relevantArtists,
  } satisfies RecommendationExplanation;
}
