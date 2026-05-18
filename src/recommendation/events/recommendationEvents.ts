import type { RecommendationEventType } from "@prisma/client";

const unifiedEventTypes = [
  "impression",
  "play",
  "skip",
  "seek",
  "like",
  "save",
  "add_to_playlist",
  "share",
] as const;

export type UnifiedRecommendationEventType = (typeof unifiedEventTypes)[number];

export interface UnifiedRecommendationEvent {
  type: UnifiedRecommendationEventType;
  trackId?: string;
  artistId?: string;
  sessionId?: string;
  sourceSurface?: string;
  position?: number;
  timestamp: string;
  recommendationRequestId?: string;
  context?: Record<string, unknown> | null;
}

export interface UnifiedRecommendationEventInput {
  type?: unknown;
  track_id?: unknown;
  trackId?: unknown;
  artist_id?: unknown;
  artistId?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  source_surface?: unknown;
  sourceSurface?: unknown;
  position?: unknown;
  timestamp?: unknown;
  occurred_at?: unknown;
  occurredAt?: unknown;
  recommendation_request_id?: unknown;
  recommendationRequestId?: unknown;
  request_id?: unknown;
  requestId?: unknown;
  context?: unknown;
}

const typeByWireType: Record<UnifiedRecommendationEventType, RecommendationEventType> = {
  impression: "IMPRESSION",
  play: "PLAY",
  skip: "SKIP",
  seek: "SEEK",
  like: "LIKE",
  save: "SAVE",
  add_to_playlist: "ADD_TO_PLAYLIST",
  share: "SHARE",
};

function readOptionalString(input: UnifiedRecommendationEventInput, snakeKey: keyof UnifiedRecommendationEventInput, camelKey: keyof UnifiedRecommendationEventInput) {
  const value = input[snakeKey] ?? input[camelKey];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalPosition(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.trunc(value);
}

function readContext(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recommendation event context must be an object");
  }

  return value as Record<string, unknown>;
}

export function mapUnifiedEventTypeToStorageType(type: UnifiedRecommendationEventType): RecommendationEventType {
  return typeByWireType[type];
}

export function normalizeUnifiedRecommendationEvent(input: UnifiedRecommendationEventInput): UnifiedRecommendationEvent {
  const rawType = input.type;
  if (typeof rawType !== "string" || !unifiedEventTypes.includes(rawType as UnifiedRecommendationEventType)) {
    throw new Error("Unsupported recommendation event type");
  }

  const timestamp = readOptionalString(input, "timestamp", "occurredAt") ?? readOptionalString(input, "occurred_at", "timestamp");
  if (!timestamp) {
    throw new Error("Recommendation event timestamp is required");
  }

  const parsedTimestamp = new Date(timestamp);
  if (Number.isNaN(parsedTimestamp.getTime())) {
    throw new Error("Recommendation event timestamp is invalid");
  }

  const event: UnifiedRecommendationEvent = {
    type: rawType as UnifiedRecommendationEventType,
    trackId: readOptionalString(input, "track_id", "trackId"),
    artistId: readOptionalString(input, "artist_id", "artistId"),
    sessionId: readOptionalString(input, "session_id", "sessionId"),
    sourceSurface: readOptionalString(input, "source_surface", "sourceSurface"),
    position: readOptionalPosition(input.position),
    timestamp: parsedTimestamp.toISOString(),
    recommendationRequestId:
      readOptionalString(input, "recommendation_request_id", "recommendationRequestId") ??
      readOptionalString(input, "request_id", "requestId"),
    context: readContext(input.context),
  };

  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as UnifiedRecommendationEvent;
}
