import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { createPrismaClient } from "../src/database/prisma";

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

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

  const registerUser = async (email = `user-${randomUUID()}@example.com`) => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email,
        password: "super-secret-password",
        username: "pingu",
        deviceName: "Desktop",
      },
    });

    return {
      response,
      body: response.json() as {
        accessToken: string;
        refreshToken: string;
        user: { id: string; email: string };
      },
    };
  };

  const createTrack = async () =>
    prisma.track.create({
      data: {
        source: "hitmo",
        sourceTrackId: randomUUID(),
        title: "Track title",
        artistName: "Artist",
      },
    });

  const resolveTrack = async (accessToken: string, sourceTrackId?: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/me/tracks/resolve",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      payload: {
        source: "hitmo",
        sourceTrackId: sourceTrackId ?? randomUUID(),
        title: "Track title",
        artistName: "Artist",
        albumTitle: "Album",
        duration: 180000,
      },
    });

    return {
      response,
      body: response.json() as { track: { id: string; sourceTrackId: string; title: string } },
    };
  };

  it("registers, logs in, refreshes, logs out, and blocks revoked refresh tokens", async () => {
    const email = `user-${randomUUID()}@example.com`;

    const register = await registerUser(email);
    expect(register.response.statusCode).toBe(201);
    expect(register.body.user.email).toBe(email);

    const duplicate = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email,
        password: "super-secret-password",
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email,
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
        email,
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

    const meWithInvalidToken = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: {
        authorization: "Bearer definitely-invalid-token",
      },
    });
    expect(meWithInvalidToken.statusCode).toBe(401);

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: {
        refreshToken: loginBody.refreshToken,
      },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toHaveProperty("accessToken");

    const refreshTokenRecord = await prisma.refreshToken.findFirstOrThrow({
      where: {
        userId: loginBody.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    await prisma.refreshToken.update({
      where: {
        id: refreshTokenRecord.id,
      },
      data: {
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const expiredRefresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: {
        refreshToken: loginBody.refreshToken,
      },
    });
    expect(expiredRefresh.statusCode).toBe(401);

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

  it("resolves track metadata into a reusable track reference", async () => {
    const { body } = await registerUser();

    const firstResolve = await resolveTrack(body.accessToken, "source-track-1");
    expect(firstResolve.response.statusCode).toBe(200);
    expect(firstResolve.body.track.title).toBe("Track title");

    const secondResolve = await app.inject({
      method: "POST",
      url: "/me/tracks/resolve",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        source: "hitmo",
        sourceTrackId: "source-track-1",
        title: "Track title updated",
        artistName: "Artist",
      },
    });

    expect(secondResolve.statusCode).toBe(200);
    expect((secondResolve.json() as { track: { id: string; title: string } }).track.id).toBe(
      firstResolve.body.track.id,
    );
    expect((secondResolve.json() as { track: { title: string } }).track.title).toBe(
      "Track title updated",
    );
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

  it("supports sync aliases for favorites, playlists, settings, and history", async () => {
    const { body } = await registerUser();
    const track = await createTrack();

    const favorites = await app.inject({
      method: "GET",
      url: "/sync/favorites",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(favorites.statusCode).toBe(200);

    const createPlaylist = await app.inject({
      method: "POST",
      url: "/sync/playlists",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        name: "Synced playlist",
      },
    });
    expect(createPlaylist.statusCode).toBe(201);

    const settings = await app.inject({
      method: "GET",
      url: "/sync/settings",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
    });
    expect(settings.statusCode).toBe(200);

    const historyEvent = await app.inject({
      method: "POST",
      url: "/sync/history/events",
      headers: {
        authorization: `Bearer ${body.accessToken}`,
      },
      payload: {
        trackId: track.id,
        eventType: "STARTED",
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
      (listPlaylists.json() as { items: Array<{ tracks: Array<{ trackId: string }> }> }).items[0]
        .tracks,
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
      const email = `rate-limit-${randomUUID()}@example.com`;
      const firstAttempt = await rateLimitedApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: {
          "x-forwarded-for": "203.0.113.10",
        },
        payload: {
          email,
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
          email,
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
