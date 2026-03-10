import argon2 from "argon2";
import jwt, { type SignOptions } from "jsonwebtoken";

import type { AppConfig } from "../config";

type RefreshTokenPayload = {
  type: "refresh";
};

export type AccessTokenPayload = {
  sub: string;
  email: string;
};

export type VerifiedRefreshToken = {
  tokenId: string;
  userId: string;
};

const hashOptions: argon2.Options & { raw?: false } = {
  type: argon2.argon2id,
};

export const hashValue = (value: string): Promise<string> => argon2.hash(value, hashOptions);

export const verifyHashedValue = (hash: string, value: string): Promise<boolean> =>
  argon2.verify(hash, value);

export const createAccessToken = (
  config: AppConfig,
  payload: AccessTokenPayload,
): string =>
  jwt.sign(
    {
      email: payload.email,
    },
    config.jwtAccessSecret,
    {
      subject: payload.sub,
      expiresIn: config.jwtAccessExpiresIn as SignOptions["expiresIn"],
    },
  );

export const createRefreshToken = (
  config: AppConfig,
  userId: string,
  tokenId: string,
): string =>
  jwt.sign({ type: "refresh" satisfies RefreshTokenPayload["type"] }, config.jwtRefreshSecret, {
    subject: userId,
    jwtid: tokenId,
    expiresIn: config.jwtRefreshExpiresIn as SignOptions["expiresIn"],
  });

export const verifyRefreshToken = (
  token: string,
  config: AppConfig,
): VerifiedRefreshToken => {
  const payload = jwt.verify(token, config.jwtRefreshSecret) as jwt.JwtPayload & RefreshTokenPayload;

  if (payload.type !== "refresh" || !payload.sub || !payload.jti) {
    throw new Error("Invalid refresh token.");
  }

  return {
    userId: payload.sub,
    tokenId: payload.jti,
  };
};
