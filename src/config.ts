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
});

