import { randomUUID } from "node:crypto";
import type { PrismaClient, User } from "@prisma/client";

import { DEFAULT_USER_SETTINGS } from "../constants";
import type { AppConfig } from "../config";
import { AppError } from "../utils/errors";
import {
  createAccessToken,
  createRefreshToken,
  hashValue,
  verifyHashedValue,
  verifyRefreshToken,
} from "../utils/tokens";

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export const createUser = async (
  prisma: PrismaClient,
  input: {
    email: string;
    password: string;
    username?: string;
    name?: string;
  },
): Promise<User> => {
  const existingUser = await prisma.user.findUnique({
    where: {
      email: input.email,
    },
  });

  if (existingUser) {
    throw new AppError(409, "EMAIL_ALREADY_EXISTS", "Email is already registered.");
  }

  const passwordHash = await hashValue(input.password);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        username: input.username,
        displayName: input.name ?? input.username ?? null,
      },
    });

    await tx.userSettings.create({
      data: {
        userId: user.id,
        ...DEFAULT_USER_SETTINGS,
      },
    });

    return user;
  });
};

export const issueTokens = async (
  prisma: PrismaClient,
  config: AppConfig,
  user: User,
  deviceName?: string,
): Promise<AuthTokens> => {
  const tokenId = randomUUID();
  const refreshToken = createRefreshToken(config, user.id, tokenId);
  const tokenHash = await hashValue(refreshToken);

  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      userId: user.id,
      tokenHash,
      deviceName: deviceName ?? null,
      expiresAt: getRefreshExpiry(config.jwtRefreshExpiresIn),
    },
  });

  return {
    accessToken: createAccessToken(config, { sub: user.id, email: user.email }),
    refreshToken,
  };
};

export const authenticateUser = async (
  prisma: PrismaClient,
  input: {
    email: string;
    password: string;
  },
): Promise<User> => {
  const user = await prisma.user.findUnique({
    where: {
      email: input.email,
    },
  });

  if (!user) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const isPasswordValid = await verifyHashedValue(user.passwordHash, input.password);
  if (!isPasswordValid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }

  return user;
};

export const refreshAccessToken = async (
  prisma: PrismaClient,
  config: AppConfig,
  rawRefreshToken: string,
): Promise<string> => {
  let verifiedToken;

  try {
    verifiedToken = verifyRefreshToken(rawRefreshToken, config);
  } catch {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired.");
  }

  const refreshTokenRecord = await prisma.refreshToken.findUnique({
    where: {
      id: verifiedToken.tokenId,
    },
    include: {
      user: true,
    },
  });

  if (
    !refreshTokenRecord ||
    refreshTokenRecord.userId !== verifiedToken.userId ||
    refreshTokenRecord.revokedAt ||
    refreshTokenRecord.expiresAt <= new Date()
  ) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired.");
  }

  const isTokenValid = await verifyHashedValue(refreshTokenRecord.tokenHash, rawRefreshToken);
  if (!isTokenValid) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired.");
  }

  return createAccessToken(config, {
    sub: refreshTokenRecord.user.id,
    email: refreshTokenRecord.user.email,
  });
};

export const revokeRefreshToken = async (
  prisma: PrismaClient,
  config: AppConfig,
  rawRefreshToken?: string,
): Promise<void> => {
  if (!rawRefreshToken?.trim()) {
    return;
  }

  let verifiedToken;

  try {
    verifiedToken = verifyRefreshToken(rawRefreshToken, config);
  } catch {
    return;
  }

  const refreshTokenRecord = await prisma.refreshToken.findUnique({
    where: {
      id: verifiedToken.tokenId,
    },
  });

  if (!refreshTokenRecord || refreshTokenRecord.userId !== verifiedToken.userId) {
    return;
  }

  const isTokenValid = await verifyHashedValue(refreshTokenRecord.tokenHash, rawRefreshToken);
  if (!isTokenValid) {
    return;
  }

  await prisma.refreshToken.update({
    where: {
      id: refreshTokenRecord.id,
    },
    data: {
      revokedAt: new Date(),
    },
  });
};

const getRefreshExpiry = (expiresIn: string): Date => {
  const normalized = expiresIn.trim();
  const match = normalized.match(/^(\d+)([smhd])$/i);

  if (!match) {
    return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  const [, amountRaw, unit] = match;
  const amount = Number(amountRaw);
  const unitToMs: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return new Date(Date.now() + amount * unitToMs[unit.toLowerCase()]);
};
