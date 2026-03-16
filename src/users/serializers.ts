import type { User } from "@prisma/client";

export const serializeUser = (user: User) => ({
  id: user.id,
  login: user.login,
  username: user.username,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});
