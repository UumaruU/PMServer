import { getProviderPriority, getProviderTrustScore } from "../providers/sourceRegistry";
import { RecommendationProviderId, RecommendationSourceTrack } from "../types";

export function getSourcePriority(providerId: RecommendationProviderId) {
  return getProviderPriority(providerId);
}

export function getSourceTrustScore(providerId: RecommendationProviderId) {
  return getProviderTrustScore(providerId);
}

export function withSourceMetadata<T extends RecommendationSourceTrack>(track: T): T {
  return {
    ...track,
    sourcePriority: track.sourcePriority ?? getSourcePriority(track.providerId),
    sourceTrustScore: track.sourceTrustScore ?? getSourceTrustScore(track.providerId),
  };
}
