CREATE TABLE "RecommendationRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "surface" TEXT NOT NULL,
    "mode" TEXT,
    "strategy" TEXT,
    "contextSummary" TEXT,
    "seed" JSONB,
    "input" JSONB,
    "userProfileSnapshot" JSONB,
    "userFeatureSnapshot" JSONB,
    "contextSnapshot" JSONB,
    "poolHealthSnapshot" JSONB,
    "candidateGeneratorSummary" JSONB,
    "expansionSummary" JSONB,
    "finalRecommendations" JSONB,
    "sampled" BOOLEAN NOT NULL DEFAULT true,
    "sampleRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "compact" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationCandidateSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID NOT NULL,
    "canonicalTrackId" TEXT,
    "preferredVariantId" TEXT,
    "stage" TEXT NOT NULL,
    "rank" INTEGER,
    "score" DOUBLE PRECISION,
    "sourceChannels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sourceSummary" JSONB,
    "reasonSummary" JSONB,
    "trackSnapshot" JSONB,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationCandidateSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationFeatureSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID NOT NULL,
    "canonicalTrackId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "features" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationFeatureSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationReasonSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID NOT NULL,
    "canonicalTrackId" TEXT,
    "candidateSnapshotId" UUID,
    "reasonType" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationReasonSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationFilterLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID NOT NULL,
    "canonicalTrackId" TEXT,
    "stage" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationFilterLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationScoreBreakdown" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID NOT NULL,
    "canonicalTrackId" TEXT,
    "rank" INTEGER,
    "finalScore" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "penalties" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationScoreBreakdown_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PoolHealthSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID NOT NULL,
    "userId" UUID,
    "poolLevel" TEXT NOT NULL,
    "health" JSONB NOT NULL,
    "plan" JSONB,
    "queuedJobs" INTEGER,
    "liveExpansion" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolHealthSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryJobLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID,
    "discoveryJobId" UUID,
    "seedId" UUID,
    "action" TEXT NOT NULL,
    "jobType" TEXT,
    "status" TEXT NOT NULL,
    "providerId" TEXT,
    "providerCallCount" INTEGER,
    "payload" JSONB,
    "resultSummary" JSONB,
    "rawPayload" JSONB,
    "rawPayloadBytes" INTEGER,
    "rawPayloadExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryJobLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderResultLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID,
    "providerId" TEXT NOT NULL,
    "operation" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "status" TEXT NOT NULL,
    "summary" JSONB,
    "rawPayload" JSONB,
    "rawPayloadBytes" INTEGER,
    "rawPayloadExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderResultLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GraphEdgeAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendationRequestId" UUID,
    "candidateTrackId" TEXT,
    "sourceNodeType" TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "targetNodeType" TEXT NOT NULL,
    "targetNodeId" TEXT NOT NULL,
    "edgeType" TEXT NOT NULL,
    "weight" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphEdgeAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecommendationRequest_userId_createdAt_idx" ON "RecommendationRequest"("userId", "createdAt");
CREATE INDEX "RecommendationRequest_surface_createdAt_idx" ON "RecommendationRequest"("surface", "createdAt");
CREATE INDEX "RecommendationRequest_expiresAt_idx" ON "RecommendationRequest"("expiresAt");

CREATE INDEX "RecommendationCandidateSnapshot_recommendationRequestId_stage_idx" ON "RecommendationCandidateSnapshot"("recommendationRequestId", "stage");
CREATE INDEX "RecommendationCandidateSnapshot_canonicalTrackId_idx" ON "RecommendationCandidateSnapshot"("canonicalTrackId");

CREATE INDEX "RecommendationFeatureSnapshot_recommendationRequestId_entityType_idx" ON "RecommendationFeatureSnapshot"("recommendationRequestId", "entityType");
CREATE INDEX "RecommendationFeatureSnapshot_entityType_entityId_idx" ON "RecommendationFeatureSnapshot"("entityType", "entityId");
CREATE INDEX "RecommendationFeatureSnapshot_canonicalTrackId_idx" ON "RecommendationFeatureSnapshot"("canonicalTrackId");

CREATE INDEX "RecommendationReasonSnapshot_recommendationRequestId_reasonType_idx" ON "RecommendationReasonSnapshot"("recommendationRequestId", "reasonType");
CREATE INDEX "RecommendationReasonSnapshot_canonicalTrackId_idx" ON "RecommendationReasonSnapshot"("canonicalTrackId");
CREATE INDEX "RecommendationReasonSnapshot_candidateSnapshotId_idx" ON "RecommendationReasonSnapshot"("candidateSnapshotId");

CREATE INDEX "RecommendationFilterLog_recommendationRequestId_reason_idx" ON "RecommendationFilterLog"("recommendationRequestId", "reason");
CREATE INDEX "RecommendationFilterLog_canonicalTrackId_idx" ON "RecommendationFilterLog"("canonicalTrackId");

CREATE INDEX "RecommendationScoreBreakdown_recommendationRequestId_rank_idx" ON "RecommendationScoreBreakdown"("recommendationRequestId", "rank");
CREATE INDEX "RecommendationScoreBreakdown_canonicalTrackId_idx" ON "RecommendationScoreBreakdown"("canonicalTrackId");

CREATE INDEX "PoolHealthSnapshot_recommendationRequestId_idx" ON "PoolHealthSnapshot"("recommendationRequestId");
CREATE INDEX "PoolHealthSnapshot_userId_createdAt_idx" ON "PoolHealthSnapshot"("userId", "createdAt");
CREATE INDEX "PoolHealthSnapshot_poolLevel_createdAt_idx" ON "PoolHealthSnapshot"("poolLevel", "createdAt");

CREATE INDEX "DiscoveryJobLog_recommendationRequestId_idx" ON "DiscoveryJobLog"("recommendationRequestId");
CREATE INDEX "DiscoveryJobLog_discoveryJobId_idx" ON "DiscoveryJobLog"("discoveryJobId");
CREATE INDEX "DiscoveryJobLog_status_createdAt_idx" ON "DiscoveryJobLog"("status", "createdAt");
CREATE INDEX "DiscoveryJobLog_rawPayloadExpiresAt_idx" ON "DiscoveryJobLog"("rawPayloadExpiresAt");

CREATE INDEX "ProviderResultLog_recommendationRequestId_idx" ON "ProviderResultLog"("recommendationRequestId");
CREATE INDEX "ProviderResultLog_providerId_operation_createdAt_idx" ON "ProviderResultLog"("providerId", "operation", "createdAt");
CREATE INDEX "ProviderResultLog_entityType_entityId_idx" ON "ProviderResultLog"("entityType", "entityId");
CREATE INDEX "ProviderResultLog_rawPayloadExpiresAt_idx" ON "ProviderResultLog"("rawPayloadExpiresAt");

CREATE INDEX "GraphEdgeAudit_recommendationRequestId_edgeType_idx" ON "GraphEdgeAudit"("recommendationRequestId", "edgeType");
CREATE INDEX "GraphEdgeAudit_candidateTrackId_idx" ON "GraphEdgeAudit"("candidateTrackId");
CREATE INDEX "GraphEdgeAudit_sourceNodeType_sourceNodeId_idx" ON "GraphEdgeAudit"("sourceNodeType", "sourceNodeId");
CREATE INDEX "GraphEdgeAudit_targetNodeType_targetNodeId_idx" ON "GraphEdgeAudit"("targetNodeType", "targetNodeId");

ALTER TABLE "RecommendationRequest"
ADD CONSTRAINT "RecommendationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecommendationCandidateSnapshot"
ADD CONSTRAINT "RecommendationCandidateSnapshot_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecommendationFeatureSnapshot"
ADD CONSTRAINT "RecommendationFeatureSnapshot_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecommendationReasonSnapshot"
ADD CONSTRAINT "RecommendationReasonSnapshot_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecommendationFilterLog"
ADD CONSTRAINT "RecommendationFilterLog_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecommendationScoreBreakdown"
ADD CONSTRAINT "RecommendationScoreBreakdown_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PoolHealthSnapshot"
ADD CONSTRAINT "PoolHealthSnapshot_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscoveryJobLog"
ADD CONSTRAINT "DiscoveryJobLog_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProviderResultLog"
ADD CONSTRAINT "ProviderResultLog_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GraphEdgeAudit"
ADD CONSTRAINT "GraphEdgeAudit_recommendationRequestId_fkey" FOREIGN KEY ("recommendationRequestId") REFERENCES "RecommendationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
