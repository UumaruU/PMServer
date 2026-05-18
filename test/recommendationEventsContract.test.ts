import { describe, expect, it } from "vitest";

import {
  mapUnifiedEventTypeToStorageType,
  normalizeUnifiedRecommendationEvent,
} from "../src/recommendation/events/recommendationEvents";

describe("unified recommendation event contract", () => {
  it("normalizes transport field names and maps event types for storage", () => {
    const event = normalizeUnifiedRecommendationEvent({
      type: "add_to_playlist",
      track_id: "track:1",
      artist_id: "artist:1",
      session_id: "session:1",
      source_surface: "stream",
      position: 2,
      timestamp: "2026-05-18T09:00:00.000Z",
      recommendation_request_id: "request:1",
      context: {
        playlistId: "playlist:1",
      },
    });

    expect(event).toEqual({
      type: "add_to_playlist",
      trackId: "track:1",
      artistId: "artist:1",
      sessionId: "session:1",
      sourceSurface: "stream",
      position: 2,
      timestamp: "2026-05-18T09:00:00.000Z",
      recommendationRequestId: "request:1",
      context: {
        playlistId: "playlist:1",
      },
    });
    expect(mapUnifiedEventTypeToStorageType(event.type)).toBe("ADD_TO_PLAYLIST");
  });

  it("rejects unknown event types", () => {
    expect(() =>
      normalizeUnifiedRecommendationEvent({
        type: "ban_forever",
        track_id: "track:1",
        timestamp: "2026-05-18T09:00:00.000Z",
      }),
    ).toThrow("Unsupported recommendation event type");
  });
});
