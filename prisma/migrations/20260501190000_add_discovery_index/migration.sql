DO $$ BEGIN
  CREATE TYPE "TrackIndexStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'MERGED', 'DISABLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DiscoveryJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "CanonicalTrack" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "albumTitle" TEXT,
    "normalizedTitle" TEXT NOT NULL,
    "normalizedArtist" TEXT NOT NULL,
    "durationMs" INTEGER,
    "coverUrl" TEXT,
    "releaseDate" TEXT,
    "musicBrainzRecordingId" TEXT,
    "musicBrainzArtistId" TEXT,
    "musicBrainzReleaseId" TEXT,
    "musicBrainzReleaseGroupId" TEXT,
    "isrc" TEXT,
    "titleFlavor" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "matchConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "indexStatus" "TrackIndexStatus" NOT NULL DEFAULT 'ACTIVE',
    "discoveredFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanonicalTrack_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Artist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "musicBrainzArtistId" TEXT,
    "type" TEXT,
    "country" TEXT,
    "area" TEXT,
    "imageUrl" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrackSource" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "canonicalTrackId" TEXT NOT NULL,
    "legacyTrackId" UUID,
    "clientTrackId" TEXT,
    "providerId" TEXT NOT NULL,
    "sourceTrackId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "albumTitle" TEXT,
    "durationMs" INTEGER,
    "coverUrl" TEXT,
    "audioUrl" TEXT,
    "sourceUrl" TEXT,
    "musicBrainzRecordingId" TEXT,
    "musicBrainzArtistId" TEXT,
    "musicBrainzReleaseId" TEXT,
    "musicBrainzReleaseGroupId" TEXT,
    "isrc" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isPlayable" BOOLEAN NOT NULL DEFAULT false,
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "matchConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "indexStatus" "TrackIndexStatus" NOT NULL DEFAULT 'ACTIVE',
    "discoveredFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArtistSource" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "artistId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "sourceArtistId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "musicBrainzArtistId" TEXT,
    "url" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArtistSimilarity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceArtistId" TEXT NOT NULL,
    "targetArtistId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistSimilarity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrackEdge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceTrackId" TEXT NOT NULL,
    "targetTrackId" TEXT,
    "artistId" TEXT,
    "edgeType" TEXT NOT NULL,
    "providerId" TEXT,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackEdge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoverySeed" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID,
    "canonicalTrackId" TEXT,
    "artistId" TEXT,
    "legacyTrackId" UUID,
    "reason" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoverySeed_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seedId" UUID,
    "jobType" TEXT NOT NULL,
    "status" "DiscoveryJobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "providerId" TEXT,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "_ArtistToCanonicalTrack" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX "TrackSource_legacyTrackId_key" ON "TrackSource"("legacyTrackId");
CREATE UNIQUE INDEX "TrackSource_clientTrackId_key" ON "TrackSource"("clientTrackId");
CREATE UNIQUE INDEX "TrackSource_providerId_sourceTrackId_key" ON "TrackSource"("providerId", "sourceTrackId");
CREATE UNIQUE INDEX "ArtistSource_providerId_sourceArtistId_key" ON "ArtistSource"("providerId", "sourceArtistId");
CREATE UNIQUE INDEX "ArtistSimilarity_sourceArtistId_targetArtistId_providerId_key" ON "ArtistSimilarity"("sourceArtistId", "targetArtistId", "providerId");
CREATE UNIQUE INDEX "TrackEdge_sourceTrackId_targetTrackId_artistId_edgeType_key" ON "TrackEdge"("sourceTrackId", "targetTrackId", "artistId", "edgeType");
CREATE UNIQUE INDEX "DiscoverySeed_userId_canonicalTrackId_reason_key" ON "DiscoverySeed"("userId", "canonicalTrackId", "reason");
CREATE UNIQUE INDEX "_ArtistToCanonicalTrack_AB_unique" ON "_ArtistToCanonicalTrack"("A", "B");

CREATE INDEX "CanonicalTrack_musicBrainzRecordingId_idx" ON "CanonicalTrack"("musicBrainzRecordingId");
CREATE INDEX "CanonicalTrack_isrc_idx" ON "CanonicalTrack"("isrc");
CREATE INDEX "CanonicalTrack_normalizedTitle_normalizedArtist_idx" ON "CanonicalTrack"("normalizedTitle", "normalizedArtist");
CREATE INDEX "CanonicalTrack_indexStatus_updatedAt_idx" ON "CanonicalTrack"("indexStatus", "updatedAt");
CREATE INDEX "TrackSource_canonicalTrackId_idx" ON "TrackSource"("canonicalTrackId");
CREATE INDEX "TrackSource_providerId_idx" ON "TrackSource"("providerId");
CREATE INDEX "TrackSource_isPlayable_indexStatus_idx" ON "TrackSource"("isPlayable", "indexStatus");
CREATE INDEX "Artist_musicBrainzArtistId_idx" ON "Artist"("musicBrainzArtistId");
CREATE INDEX "Artist_normalizedName_idx" ON "Artist"("normalizedName");
CREATE INDEX "ArtistSource_artistId_idx" ON "ArtistSource"("artistId");
CREATE INDEX "ArtistSource_musicBrainzArtistId_idx" ON "ArtistSource"("musicBrainzArtistId");
CREATE INDEX "ArtistSimilarity_sourceArtistId_idx" ON "ArtistSimilarity"("sourceArtistId");
CREATE INDEX "ArtistSimilarity_targetArtistId_idx" ON "ArtistSimilarity"("targetArtistId");
CREATE INDEX "TrackEdge_sourceTrackId_idx" ON "TrackEdge"("sourceTrackId");
CREATE INDEX "TrackEdge_targetTrackId_idx" ON "TrackEdge"("targetTrackId");
CREATE INDEX "TrackEdge_artistId_idx" ON "TrackEdge"("artistId");
CREATE INDEX "TrackEdge_edgeType_idx" ON "TrackEdge"("edgeType");
CREATE INDEX "DiscoverySeed_userId_createdAt_idx" ON "DiscoverySeed"("userId", "createdAt");
CREATE INDEX "DiscoverySeed_canonicalTrackId_idx" ON "DiscoverySeed"("canonicalTrackId");
CREATE INDEX "DiscoverySeed_artistId_idx" ON "DiscoverySeed"("artistId");
CREATE INDEX "DiscoveryJob_status_runAfter_priority_idx" ON "DiscoveryJob"("status", "runAfter", "priority");
CREATE INDEX "DiscoveryJob_seedId_idx" ON "DiscoveryJob"("seedId");
CREATE INDEX "DiscoveryJob_jobType_idx" ON "DiscoveryJob"("jobType");
CREATE INDEX "_ArtistToCanonicalTrack_B_index" ON "_ArtistToCanonicalTrack"("B");

ALTER TABLE "TrackSource" ADD CONSTRAINT "TrackSource_canonicalTrackId_fkey" FOREIGN KEY ("canonicalTrackId") REFERENCES "CanonicalTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackSource" ADD CONSTRAINT "TrackSource_legacyTrackId_fkey" FOREIGN KEY ("legacyTrackId") REFERENCES "Track"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtistSource" ADD CONSTRAINT "ArtistSource_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtistSimilarity" ADD CONSTRAINT "ArtistSimilarity_sourceArtistId_fkey" FOREIGN KEY ("sourceArtistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtistSimilarity" ADD CONSTRAINT "ArtistSimilarity_targetArtistId_fkey" FOREIGN KEY ("targetArtistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackEdge" ADD CONSTRAINT "TrackEdge_sourceTrackId_fkey" FOREIGN KEY ("sourceTrackId") REFERENCES "CanonicalTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackEdge" ADD CONSTRAINT "TrackEdge_targetTrackId_fkey" FOREIGN KEY ("targetTrackId") REFERENCES "CanonicalTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackEdge" ADD CONSTRAINT "TrackEdge_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoverySeed" ADD CONSTRAINT "DiscoverySeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoverySeed" ADD CONSTRAINT "DiscoverySeed_canonicalTrackId_fkey" FOREIGN KEY ("canonicalTrackId") REFERENCES "CanonicalTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoverySeed" ADD CONSTRAINT "DiscoverySeed_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoverySeed" ADD CONSTRAINT "DiscoverySeed_legacyTrackId_fkey" FOREIGN KEY ("legacyTrackId") REFERENCES "Track"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DiscoveryJob" ADD CONSTRAINT "DiscoveryJob_seedId_fkey" FOREIGN KEY ("seedId") REFERENCES "DiscoverySeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ArtistToCanonicalTrack" ADD CONSTRAINT "_ArtistToCanonicalTrack_A_fkey" FOREIGN KEY ("A") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ArtistToCanonicalTrack" ADD CONSTRAINT "_ArtistToCanonicalTrack_B_fkey" FOREIGN KEY ("B") REFERENCES "CanonicalTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;
