CREATE TABLE "UserSearchHistoryEntry" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSearchHistoryEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserSearchHistoryEntry_userId_createdAt_idx" ON "UserSearchHistoryEntry"("userId", "createdAt");

ALTER TABLE "UserSearchHistoryEntry"
ADD CONSTRAINT "UserSearchHistoryEntry_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
