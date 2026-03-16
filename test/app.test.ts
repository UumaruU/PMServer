import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { createPrismaClient } from "../src/database/prisma";

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

function buildLogin() {
  return `u_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function buildExternalTrackId(source: string, sourceTrackId: string) {
  return `${source}:${sourceTrackId}`;
}

describeIfDb("Pingu Music API", () => {
  const prisma = createPrismaClient(testDatabaseUrl);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: testDatabaseUrl!,
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? "test-access-secret",
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret",
    jwtAccessExpiresIn: "15m",
    jwtRefreshExpiresIn: "30d",
    rateLimitMax: 50,
    rateLimitWindow: "1 minute",
  };

  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      config,
      prisma,
      logger: false,
    });

    await app.ready();
  });

  beforeEach(async () => {
    await prisma.userRecommendationEvent.deleteMany();
    await prisma.userRecommendationCacheEntry.deleteMany();
    await prisma.userRecommendationProfile.deleteMany();
    await prisma.userSearchHistoryEntry.deleteMany();
    await prisma.playlistTrack.deleteMany();
    await prisma.favorite.deleteMany();
    await prisma.userHistoryEvent.deleteMany();
    await prisma.playlist.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.userSettings.deleteMany();
    await prisma.track.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  const registerUser = async (login = buildLogin()) => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        login,
        password: "super-secret-password",
        deviceName: "Desktop",
      },
    });

    return {
      response,
      body: response.json() as {
        accessToken: string;
        refreshToken: string;
        user: { id: string; login: string };
      },
    };
  };

  const createTrack = async (input: Partial<{
    source: string;
    sourceTrackId: string;
    title: string;
    artistName: string;
    audioUrl: string | null;
    duration: number | null;
    clientTrackId: string | null;
  }> = {}) =>
    prisma.track.create({
      data: {
        source: input.source ?? "hitmos",
        sourceTrackId: input.sourceTrackId ?? randomUUID(),
        clientTrackId: input.clientTrackId ?? null,
        title: input.title ?? "Track title",
        artistName: input.artistName ?? "Artist",
        audioUrl: input.audioUrl ?? "https://example.invalid/audio.mp3",
        duration: input.duration ?? 180000,
      },
    });

  const resolveTrack = async (
    accessToken: string,
    input: Partial<{
      clientTrackId: string | null;
      source: string;
      sourceTrackId: string;
      title: string;
      artistName: string;
      albumTitle: string | null;
      duration: number | null;
      audioUrl: string | null;
      coverUrl: string | null;
      musicBrainzRecordingId: string | null;
      musicBrainzArtistId: string | null;
      musicBrainzReleaseId: string | null;
    }> = {},
  ) => {
    const source = input.source ?? "hitmos";
    const sourceTrackId = input.sourceTrackId ?? randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/me/tracks/resolve",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      payload: {
        clientTrackId: input.clientTrackId ?? buildExternalTrackId(source, sourceTrackId),
        source,
        sourceTrackId,
        title: input.title ?? "Track title",
        artistName: input.artistName ?? "Artist",
        albumTitle: input.albumTitle ?? "Album",
        duration: input.duration ?? 180000,
        audioUrl: input.audioUrl ?? "https://example.invalid/audio.mp3",
        coverUrl: input.coverUrl ?? "https://example.invalid/cover.jpg",
        musicBrainzRecordingId: input.musicBrainzRecordingId ?? null,
        musicBrainzArtistId: input.musicBrainzArtistId ?? null,
        musicBrainzReleaseId: input.musicBrainzReleaseId ?? null,
      },
    });

    return {
      response,
      source,
      sourceTrackId,
      externalTrackId: buildExternalTrackId(source, sourceTrackId),
      body: response.json() as {
        track: {
          id: string;
          clientTrackId: string | null;
          source: string;
          sourceTrackId: string;
          title: string;
        };
      },
    };
  };

  it("registers, logs in, refreshes, logs out, and blocks revoked refresh tokens", async () => {
    const loginName = buildLogin();

    const register = await registerUser(loginName);
    expect(register.response.statusCode).toBe(201);
    expect(register.body.user.login).toBe(loginName);

    const duplicate = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        login: loginName,
        password: "super-secret-password",
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        login: loginName,
        password: "super-secret-password",
        deviceName: "Desktop",
      },
    });
    expect(login.statusCode).toBe(200);

    const loginBody = login.json() as {
      accessToken: string;
      refreshToken: string;
      user: { id: string };
    };

    const invalidPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        login: loginName,
        password: "wrong-password",
      },
    });
    expect(invalidPassword.statusCode).toBe(401);

    const meWithoutToken = await app.inject({
      method: "GET",
      url: "/auth/me",
    });
    expect(meWithoutToken.statusCode).toBe(401);

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`,
      },
    });
    expect(me.statusCode).toBe(200);

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: {
        refreshToken: loginBody.refreshToken,
      },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toHaveProperty("accessToken");

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: {
        refreshToken: loginBody.refreshToken,
      },
    });
    expect(logout.statusCode).toBe(204);

    const refreshAfterLogout = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: {
        refreshToken: loginBody.refreshToken,
      },
    });
    expect(refreshAfterLogout.statusCode).toBe(401);
  });

  it("resolves track metadata into a reusable track reference with stable clientTrackId", async () => {
    const { body } = await registerUser();

    const firstResolve = await resolveTrack(body.accessToken, {
      sourceTrackId: "source-track-1",
      title: "Track title",
    });
    expect(firstResolve.response.statusCode).toBe(200);
    expect(firstResolve.body.track.title).toBe("Track title");
    expect(firstResolve.body.track.clientTrackId).toBe("hitmos:source-track-1");

    const secondResolve = await resolveTrack(body.accessToken, {
      sourceTrackId: "source-track-1",
      title: "Track title updated",
    });

    expect(secondResolve.response.statusCode).toBe(200);
    expect(secondResolve.body.track.id).toBe(firstResolve.body.track.id);
    expect(secondResolve.body.track.title).toBe("Track title updated");
  });

  it("adds and removes favorites while rejecting duplicates", async () => {
    const { body } = await registerUser();
    const track = await createTrack();

    const addFavorite = await app.inject({
      method: "POST",
      url: "/me/favorites",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: track.id,
      },
    });
    expect(addFavorite.statusCode).toBe(201);

    const duplicateFavorite = await app.inject({
      method: "POST",
      url: "/me/favorites",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: track.id,
      },
    });
    expect(duplicateFavorite.statusCode).toBe(409);

    const listFavorites = await app.inject({
      method: "GET",
      url: "/me/favorites",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(listFavorites.statusCode).toBe(200);
    expect((listFavorites.json() as { items: Array<{ id: string }> }).items).toHaveLength(1);

    const removeFavorite = await app.inject({
      method: "DELETE",
      url: `/me/favorites/${track.id}`,
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(removeFavorite.statusCode).toBe(204);
  });

  it("supports sync aliases for favorites, playlists, settings, history, and search history", async () => {
    const { body } = await registerUser();
    const track = await createTrack({
      source: "hitmos",
      sourceTrackId: "sync-track-1",
      clientTrackId: "hitmos:sync-track-1",
    });
    const externalTrackId = buildExternalTrackId(track.source, track.sourceTrackId);

    const pushFavorites = await app.inject({
      method: "PUT",
      url: "/sync/favorites",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackIds: [externalTrackId],
      },
    });
    expect(pushFavorites.statusCode).toBe(204);

    const favorites = await app.inject({
      method: "GET",
      url: "/sync/favorites",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(favorites.statusCode).toBe(200);
    expect((favorites.json() as { favorites: string[] }).favorites).toEqual([externalTrackId]);

    const syncPlaylists = await app.inject({
      method: "PUT",
      url: "/sync/playlists",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        playlists: [
          {
            name: "Synced playlist",
            trackIds: [externalTrackId],
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    expect(syncPlaylists.statusCode).toBe(204);

    const playlists = await app.inject({
      method: "GET",
      url: "/sync/playlists",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(playlists.statusCode).toBe(200);
    expect((playlists.json() as { playlists: Array<{ trackIds: string[] }> }).playlists[0].trackIds).toEqual([
      externalTrackId,
    ]);

    const settings = await app.inject({
      method: "GET",
      url: "/sync/settings",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(settings.statusCode).toBe(200);

    const updateSettings = await app.inject({
      method: "PUT",
      url: "/sync/settings",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        settings: {
          volume: 0.42,
          shuffleEnabled: true,
        },
      },
    });
    expect(updateSettings.statusCode).toBe(204);

    const historyEvent = await app.inject({
      method: "POST",
      url: "/sync/history/events",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: externalTrackId,
        playedMs: 12345,
      },
    });
    expect(historyEvent.statusCode).toBe(201);

    const history = await app.inject({
      method: "GET",
      url: "/sync/history",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(history.statusCode).toBe(200);
    expect((history.json() as { items: Array<{ trackId: string }> }).items[0].trackId).toBe(externalTrackId);

    const syncSearchHistory = await app.inject({
      method: "PUT",
      url: "/sync/search-history",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        items: [
          {
            query: "night drive",
            createdAt: new Date("2026-03-16T10:00:00.000Z").toISOString(),
          },
          {
            query: "midnight echo",
            createdAt: new Date("2026-03-16T11:00:00.000Z").toISOString(),
          },
        ],
      },
    });
    expect(syncSearchHistory.statusCode).toBe(204);

    const searchHistory = await app.inject({
      method: "GET",
      url: "/sync/search-history",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(searchHistory.statusCode).toBe(200);
    expect(
      (searchHistory.json() as { items: Array<{ query: string }> }).items.map((item) => item.query),
    ).toEqual(["midnight echo", "night drive"]);
  });

  it("creates, updates, and deletes playlists with tracks", async () => {
    const { body } = await registerUser();
    const track = await createTrack();

    const createPlaylist = await app.inject({
      method: "POST",
      url: "/me/playlists",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        name: "Daily Mix",
        description: "Favorites for work",
      },
    });
    expect(createPlaylist.statusCode).toBe(201);

    const playlistId = (createPlaylist.json() as { playlist: { id: string } }).playlist.id;

    const updatePlaylist = await app.inject({
      method: "PATCH",
      url: `/me/playlists/${playlistId}`,
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        name: "Daily Mix Updated",
      },
    });
    expect(updatePlaylist.statusCode).toBe(200);

    const addTrack = await app.inject({
      method: "POST",
      url: `/me/playlists/${playlistId}/tracks`,
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: track.id,
      },
    });
    expect(addTrack.statusCode).toBe(201);

    const duplicateTrack = await app.inject({
      method: "POST",
      url: `/me/playlists/${playlistId}/tracks`,
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: track.id,
      },
    });
    expect(duplicateTrack.statusCode).toBe(409);

    const listPlaylists = await app.inject({
      method: "GET",
      url: "/me/playlists",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(listPlaylists.statusCode).toBe(200);
    expect(
      (listPlaylists.json() as { items: Array<{ tracks: Array<{ trackId: string }> }> }).items[0].tracks,
    ).toHaveLength(1);

    const removeTrack = await app.inject({
      method: "DELETE",
      url: `/me/playlists/${playlistId}/tracks/${track.id}`,
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(removeTrack.statusCode).toBe(204);

    const deletePlaylist = await app.inject({
      method: "DELETE",
      url: `/me/playlists/${playlistId}`,
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(deletePlaylist.statusCode).toBe(204);
  });

  it("recreates default settings and allows partial updates", async () => {
    const { body } = await registerUser();

    await prisma.userSettings.delete({
      where: {
        userId: body.user.id,
      },
    });

    const getSettings = await app.inject({
      method: "GET",
      url: "/me/settings",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(getSettings.statusCode).toBe(200);
    expect((getSettings.json() as { volume: number }).volume).toBe(100);

    const patchSettings = await app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        volume: 42,
        shuffleEnabled: true,
      },
    });
    expect(patchSettings.statusCode).toBe(200);
    expect((patchSettings.json() as { volume: number; shuffleEnabled: boolean }).volume).toBe(42);
  });

  it("stores and returns history in reverse chronological order", async () => {
    const { body } = await registerUser();
    const firstTrack = await createTrack();
    const secondTrack = await createTrack();

    const firstEvent = await app.inject({
      method: "POST",
      url: "/me/history/events",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: firstTrack.id,
        eventType: "STARTED",
        playedMs: 1000,
        context: {
          source: "playlist",
        },
      },
    });
    expect(firstEvent.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const secondEvent = await app.inject({
      method: "POST",
      url: "/me/history/events",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: secondTrack.id,
        eventType: "COMPLETED",
        playedMs: 2500,
      },
    });
    expect(secondEvent.statusCode).toBe(201);

    const history = await app.inject({
      method: "GET",
      url: "/me/history?limit=10&offset=0",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(history.statusCode).toBe(200);

    const historyBody = history.json() as {
      items: Array<{ trackId: string }>;
      pagination: { total: number };
    };

    expect(historyBody.pagination.total).toBe(2);
    expect(historyBody.items[0].trackId).toBe(secondTrack.id);
    expect(historyBody.items[1].trackId).toBe(firstTrack.id);
  });

  it("returns server-side recommendation stream and persists affinity events per user", async () => {
    const { body } = await registerUser();
    const primary = await resolveTrack(body.accessToken, {
      sourceTrackId: "rec-track-1",
      title: "Night Drive",
      artistName: "Northern Lights",
      audioUrl: "https://example.invalid/rec-track-1.mp3",
      duration: 210000,
      musicBrainzArtistId: "mb-artist-1",
    });
    const secondary = await resolveTrack(body.accessToken, {
      sourceTrackId: "rec-track-2",
      title: "Night Drive Pt. 2",
      artistName: "Northern Lights",
      audioUrl: "https://example.invalid/rec-track-2.mp3",
      duration: 205000,
      musicBrainzArtistId: "mb-artist-1",
    });
    await resolveTrack(body.accessToken, {
      sourceTrackId: "rec-track-3",
      title: "Midnight Echo",
      artistName: "Northern Lights",
      audioUrl: "https://example.invalid/rec-track-3.mp3",
      duration: 215000,
      musicBrainzArtistId: "mb-artist-1",
    });

    const favorite = await app.inject({
      method: "POST",
      url: "/me/favorites",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: primary.body.track.id,
      },
    });
    expect(favorite.statusCode).toBe(201);

    const historyEvent = await app.inject({
      method: "POST",
      url: "/me/history/events",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: secondary.body.track.id,
        eventType: "COMPLETED",
        playedMs: 200000,
      },
    });
    expect(historyEvent.statusCode).toBe(201);

    const stream = await app.inject({
      method: "POST",
      url: "/me/recommendations/stream",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        limit: 5,
        mode: "autoplay",
        currentTrackId: primary.externalTrackId,
      },
    });
    expect(stream.statusCode).toBe(200);

    const streamBody = stream.json() as {
      items: Array<{
        preferredVariantId: string;
        track: { id: string; audioUrl: string };
      }>;
    };
    expect(streamBody.items.length).toBeGreaterThan(0);
    expect(streamBody.items[0].track.id).toBe(streamBody.items[0].preferredVariantId);
    expect(streamBody.items[0].track.audioUrl).toContain("https://");

    const playback = await app.inject({
      method: "POST",
      url: "/me/recommendations/events/playback",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: primary.externalTrackId,
        listenedMs: 200000,
        trackDurationMs: 210000,
        occurredAt: new Date().toISOString(),
        endedNaturally: true,
        wasSkipped: false,
        sessionId: "test-session",
        seedChannels: ["sessionContinuation"],
      },
    });
    expect(playback.statusCode).toBe(204);

    expect(await prisma.userRecommendationProfile.findUnique({ where: { userId: body.user.id } })).not.toBeNull();
    expect(await prisma.userRecommendationEvent.count({ where: { userId: body.user.id } })).toBeGreaterThan(0);
  });

  it("rate limits auth endpoints", async () => {
    const rateLimitedApp = await buildApp({
      config: {
        ...config,
        rateLimitMax: 1,
      },
      prisma,
      logger: false,
    });

    await rateLimitedApp.ready();

    try {
      const login = buildLogin();
      const firstAttempt = await rateLimitedApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: {
          "x-forwarded-for": "203.0.113.10",
        },
        payload: {
          login,
          password: "super-secret-password",
        },
      });

      const secondAttempt = await rateLimitedApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: {
          "x-forwarded-for": "203.0.113.10",
        },
        payload: {
          login,
          password: "super-secret-password",
        },
      });

      expect(firstAttempt.statusCode).toBe(401);
      expect(secondAttempt.statusCode).toBe(429);
    } finally {
      await rateLimitedApp.close();
    }
  });
});
