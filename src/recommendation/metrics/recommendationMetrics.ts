export interface OfflineRecommendationMetricItem {
  trackId: string;
  artistId?: string | null;
  clusterId?: string | null;
  shownBefore?: boolean;
}

export interface OfflineRecommendationMetricsInput {
  recommendations: OfflineRecommendationMetricItem[];
  relevantTrackIds: string[];
  catalogTrackIds: string[];
  catalogArtistIds: string[];
  k?: number;
}

export interface OfflineRecommendationMetrics {
  recall: number;
  ndcg: number;
  novelty: number;
  catalogCoverage: number;
  artistCoverage: number;
  sameArtistShare: number;
}

export interface OnlineRecommendationMetricEvent {
  userId: string;
  trackId?: string | null;
  artistId?: string | null;
  eventType: string;
  occurredAt: string;
  isNewArtistForUser?: boolean;
}

export interface OnlineRecommendationMetricsInput {
  events: OnlineRecommendationMetricEvent[];
  now?: string;
}

export interface OnlineRecommendationMetrics {
  saveRate: number;
  newArtistDiscoveryRate: number;
  revisit7d: number;
  revisit28d: number;
  annoyanceProxy: number;
  fatigueProxy: number;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function parseTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueCount(values: Array<string | null | undefined>) {
  return new Set(values.filter((value): value is string => !!value)).size;
}

function discountedGain(rankIndex: number) {
  return 1 / Math.log2(rankIndex + 2);
}

export function calculateOfflineRecommendationMetrics(
  input: OfflineRecommendationMetricsInput,
): OfflineRecommendationMetrics {
  const k = Math.max(1, input.k ?? input.recommendations.length);
  const recommendations = input.recommendations.slice(0, k);
  const relevant = new Set(input.relevantTrackIds);
  const relevantHitCount = recommendations.filter((item) => relevant.has(item.trackId)).length;
  const dcg = recommendations.reduce((sum, item, index) => sum + (relevant.has(item.trackId) ? discountedGain(index) : 0), 0);
  const idealRelevantCount = Math.min(relevant.size, recommendations.length);
  let idcg = 0;
  for (let index = 0; index < idealRelevantCount; index += 1) {
    idcg += discountedGain(index);
  }
  const mostServedArtistCount = Math.max(
    0,
    ...Object.values(
      recommendations.reduce<Record<string, number>>((counts, item) => {
        if (item.artistId) {
          counts[item.artistId] = (counts[item.artistId] ?? 0) + 1;
        }
        return counts;
      }, {}),
    ),
  );

  return {
    recall: ratio(relevantHitCount, relevant.size),
    ndcg: ratio(dcg, idcg),
    novelty: ratio(recommendations.filter((item) => !item.shownBefore).length, recommendations.length),
    catalogCoverage: ratio(uniqueCount(recommendations.map((item) => item.trackId)), input.catalogTrackIds.length),
    artistCoverage: ratio(uniqueCount(recommendations.map((item) => item.artistId)), input.catalogArtistIds.length),
    sameArtistShare: ratio(mostServedArtistCount, recommendations.length),
  };
}

export function calculateOnlineRecommendationMetrics(input: OnlineRecommendationMetricsInput): OnlineRecommendationMetrics {
  const events = input.events.slice();
  const impressions = events.filter((event) => event.eventType === "IMPRESSION");
  const positiveEvents = events.filter((event) => ["SAVE", "LIKE", "ADD_TO_PLAYLIST"].includes(event.eventType));
  const negativeEvents = events.filter((event) => ["SKIP", "DISLIKE"].includes(event.eventType));
  const now = parseTime(input.now ?? new Date().toISOString());
  const byUserTrack = new Map<string, OnlineRecommendationMetricEvent[]>();

  events.forEach((event) => {
    if (!event.trackId) {
      return;
    }

    const key = `${event.userId}:${event.trackId}`;
    byUserTrack.set(key, [...(byUserTrack.get(key) ?? []), event]);
  });

  let revisit7dCount = 0;
  let revisit28dCount = 0;
  byUserTrack.forEach((trackEvents) => {
    const impressionsForTrack = trackEvents.filter((event) => event.eventType === "IMPRESSION").sort((left, right) => parseTime(left.occurredAt) - parseTime(right.occurredAt));
    const playsForTrack = trackEvents.filter((event) => event.eventType === "PLAY");
    const firstImpressionAt = parseTime(impressionsForTrack[0]?.occurredAt ?? "");
    if (!firstImpressionAt) {
      return;
    }

    if (playsForTrack.some((event) => parseTime(event.occurredAt) > firstImpressionAt && parseTime(event.occurredAt) - firstImpressionAt <= 7 * 24 * 60 * 60 * 1000)) {
      revisit7dCount += 1;
    }
    if (playsForTrack.some((event) => parseTime(event.occurredAt) > firstImpressionAt && parseTime(event.occurredAt) - firstImpressionAt <= 28 * 24 * 60 * 60 * 1000)) {
      revisit28dCount += 1;
    }
  });

  const recentlyRepeatedImpressions = impressions.filter((event, index) => {
    if (!event.trackId || !event.artistId) {
      return false;
    }

    const eventTime = parseTime(event.occurredAt);
    return impressions.some(
      (other, otherIndex) =>
        otherIndex < index &&
        other.userId === event.userId &&
        other.artistId === event.artistId &&
        eventTime - parseTime(other.occurredAt) <= 60 * 60 * 1000,
    );
  }).length;

  return {
    saveRate: ratio(positiveEvents.length, impressions.length),
    newArtistDiscoveryRate: ratio(positiveEvents.filter((event) => event.isNewArtistForUser).length, positiveEvents.length),
    revisit7d: ratio(revisit7dCount, byUserTrack.size),
    revisit28d: ratio(revisit28dCount, byUserTrack.size),
    annoyanceProxy: ratio(negativeEvents.length, impressions.length),
    fatigueProxy: ratio(recentlyRepeatedImpressions, impressions.length),
  };
}
