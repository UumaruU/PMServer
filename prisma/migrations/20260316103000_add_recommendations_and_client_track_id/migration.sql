CREATE TYPE "RecommendationEventType" AS ENUM ('PLAYBACK', 'FAVORITE', 'PLAYLIST', 'DISLIKE');

ALTER TABLE "Track"
ADD COLUMN "clientTrackId" TEXT;

UPDATE "Track"
SET "clientTrackId" = CASE
  WHEN "source" = 'client-sync' THEN "sourceTrackId"
  ELSE CONCAT("source", ':', "sourceTrackId")
END
WHERE "clientTrackId" IS NULL;

CREATE UNIQUE INDEX "Track_clientTrackId_key" ON "Track"("clientTrackId");

CREATE TABLE "UserRecommendationProfile" (
    "userId" UUID NOT NULL,
    "longTermProfile" JSONB NOT NULL,
    "sessionProfile" JSONB NOT NULL,
    "entityProfile" JSONB NOT NULL,
    "profileRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRecommendationProfile_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "UserRecommendationCacheEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "UserRecommendationCacheEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserRecommendationEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "trackId" UUID,
    "eventType" "RecommendationEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRecommendationEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserRecommendationCacheEntry_userId_cacheKey_key" ON "UserRecommendationCacheEntry"("userId", "cacheKey");
CREATE INDEX "UserRecommendationCacheEntry_userId_idx" ON "UserRecommendationCacheEntry"("userId");
CREATE INDEX "UserRecommendationEvent_userId_createdAt_idx" ON "UserRecommendationEvent"("userId", "createdAt");
CREATE INDEX "UserRecommendationEvent_trackId_idx" ON "UserRecommendationEvent"("trackId");

ALTER TABLE "UserRecommendationProfile"
ADD CONSTRAINT "UserRecommendationProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserRecommendationCacheEntry"
ADD CONSTRAINT "UserRecommendationCacheEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserRecommendationEvent"
ADD CONSTRAINT "UserRecommendationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserRecommendationEvent"
ADD CONSTRAINT "UserRecommendationEvent_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE SET NULL ON UPDATE CASCADE;
