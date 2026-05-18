export type LiveTrackIndexStatus =
  | "RAW"
  | "CANDIDATE"
  | "ACTIVE"
  | "TRUSTED"
  | "REJECTED"
  | "BLOCKED";

export interface QualityGateInput {
  isPlayable: boolean;
  qualityScore: number;
  matchConfidence: number;
  sourceTrust: number;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function finiteOrZero(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function isLowQuality(input: QualityGateInput) {
  return (
    finiteOrZero(input.qualityScore) < 0.3 ||
    finiteOrZero(input.matchConfidence) < 0.35 ||
    finiteOrZero(input.sourceTrust) < 0.18
  );
}

function isTrusted(input: QualityGateInput) {
  return (
    input.isPlayable &&
    finiteOrZero(input.qualityScore) >= 0.85 &&
    finiteOrZero(input.matchConfidence) >= 0.9 &&
    finiteOrZero(input.sourceTrust) >= 0.75
  );
}

export function resolveSourceIndexStatus(input: QualityGateInput): LiveTrackIndexStatus {
  if (isLowQuality(input)) {
    return "REJECTED";
  }

  if (!input.isPlayable) {
    return "CANDIDATE";
  }

  return isTrusted(input) ? "TRUSTED" : "ACTIVE";
}

export function resolveCanonicalIndexStatus(input: QualityGateInput): LiveTrackIndexStatus {
  if (isLowQuality(input)) {
    return "REJECTED";
  }

  if (!input.isPlayable) {
    return "CANDIDATE";
  }

  return isTrusted(input) ? "TRUSTED" : "ACTIVE";
}

export function keepBestIndexStatus(
  existing: string | null | undefined,
  next: LiveTrackIndexStatus,
): LiveTrackIndexStatus {
  if (existing === "BLOCKED") {
    return "BLOCKED";
  }

  const rank: Record<string, number> = {
    RAW: 0,
    PENDING: 0,
    CANDIDATE: 1,
    REJECTED: 1,
    DISABLED: 1,
    MERGED: 1,
    ACTIVE: 2,
    TRUSTED: 3,
    BLOCKED: 4,
  };

  return (rank[existing ?? "RAW"] ?? 0) > (rank[next] ?? 0)
    ? (existing as LiveTrackIndexStatus)
    : next;
}

export function buildFreshnessPatch(input: {
  now: Date;
  isPlayable: boolean;
  qualityScore: number;
  sourceTrust: number;
}) {
  return {
    lastIndexedAt: input.now,
    lastProviderCheckAt: input.now,
    lastSeenAt: input.now,
    metadataFreshness: clamp01((finiteOrZero(input.qualityScore) + finiteOrZero(input.sourceTrust)) / 2),
    playableSourceFreshness: input.isPlayable ? 1 : 0,
  };
}
