import dotenv from "dotenv";

dotenv.config();

export type AppConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessExpiresIn: string;
  jwtRefreshExpiresIn: string;
  rateLimitMax: number;
  rateLimitWindow: string;
  lastfmApiKey: string | null;
  deezerApiBaseUrl: string;
  listenBrainzApiBaseUrl: string;
  discoveryWorkerEnabled: boolean;
  discoveryLiveExpansionEnabled: boolean;
  discoveryMaxLiveProviderCalls: number;
  discoveryMaxJobsPerTick: number;
  discoveryBackfillOnStartup: boolean;
  discoveryBackfillBatchSize: number;
};

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const getNumberEnv = (name: string, fallback: number): number => {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return parsed;
};

const getBooleanEnv = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

export const loadConfig = (): AppConfig => ({
  host: process.env.HOST ?? "0.0.0.0",
  port: getNumberEnv("PORT", 3000),
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  jwtAccessSecret: getRequiredEnv("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: getRequiredEnv("JWT_REFRESH_SECRET"),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "30d",
  rateLimitMax: getNumberEnv("RATE_LIMIT_MAX", 5),
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
  lastfmApiKey: process.env.LASTFM_API_KEY ?? null,
  deezerApiBaseUrl: process.env.DEEZER_API_BASE_URL ?? "https://api.deezer.com",
  listenBrainzApiBaseUrl: process.env.LISTENBRAINZ_API_BASE_URL ?? "https://api.listenbrainz.org/1",
  discoveryWorkerEnabled: getBooleanEnv("DISCOVERY_WORKER_ENABLED", false),
  discoveryLiveExpansionEnabled: getBooleanEnv("DISCOVERY_LIVE_EXPANSION_ENABLED", true),
  discoveryMaxLiveProviderCalls: getNumberEnv("DISCOVERY_MAX_LIVE_PROVIDER_CALLS", 8),
  discoveryMaxJobsPerTick: getNumberEnv("DISCOVERY_MAX_JOBS_PER_TICK", 3),
  discoveryBackfillOnStartup: getBooleanEnv("DISCOVERY_BACKFILL_ON_STARTUP", true),
  discoveryBackfillBatchSize: getNumberEnv("DISCOVERY_BACKFILL_BATCH_SIZE", 200),
});
