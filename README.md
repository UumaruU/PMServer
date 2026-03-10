# Pingu Music Backend

MVP backend service for the Pingu Music desktop client. The service stores user accounts and cloud-synced metadata such as favorites, playlists, settings, and listening history.

## Stack

- Node.js
- TypeScript
- Fastify
- Prisma ORM
- PostgreSQL
- JWT access/refresh tokens
- argon2 password hashing

## Environment

Create `.env` from `.env.example` and fill in real values:

```bash
PORT=3000
HOST=0.0.0.0
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pingu_music
JWT_ACCESS_SECRET=replace-with-access-secret
JWT_REFRESH_SECRET=replace-with-refresh-secret
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
RATE_LIMIT_MAX=5
RATE_LIMIT_WINDOW=1 minute
```

## Run locally

```bash
npm install
npm run prisma:generate
npm run prisma:deploy
npm run dev
```

Expected local PostgreSQL setup:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pingu_music
```

Create the application database before running migrations if it does not already exist.

Production build:

```bash
npm run build
npm run start
```

For a fresh local database you can also use:

```bash
npm run prisma:migrate
```

## API summary

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`
- `POST /me/tracks/resolve`
- `GET /me/favorites`
- `POST /me/favorites`
- `DELETE /me/favorites/:trackId`
- `GET /me/playlists`
- `POST /me/playlists`
- `PATCH /me/playlists/:playlistId`
- `DELETE /me/playlists/:playlistId`
- `POST /me/playlists/:playlistId/tracks`
- `DELETE /me/playlists/:playlistId/tracks/:trackId`
- `GET /me/settings`
- `PATCH /me/settings`
- `POST /me/history/events`
- `GET /me/history`

All `/me/*` routes and `GET /auth/me` require `Authorization: Bearer <accessToken>`.

## Notes

- Tracks are referenced by existing `trackId`; this service does not expose public track CRUD in the MVP.
- `POST /me/tracks/resolve` upserts provider metadata and returns a stable backend `track.id` for favorites, playlists, and history.
- Refresh tokens are stored in the database only as hashes.
- Auth endpoints are rate limited per IP.

## Tests

Integration tests use `Fastify.inject` and a PostgreSQL database from `TEST_DATABASE_URL` or `DATABASE_URL`.

```bash
npm test
```

Recommended local flow:

```bash
$env:TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/pingu_music_test"
$env:JWT_ACCESS_SECRET="test-access-secret"
$env:JWT_REFRESH_SECRET="test-refresh-secret"
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npx prisma migrate deploy
npm test
```

Create the `pingu_music_test` database in PostgreSQL before running the test flow.

If neither database URL is configured, the integration suite is skipped.
