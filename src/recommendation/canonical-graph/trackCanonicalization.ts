import {
  CanonicalDebugInfo,
  CanonicalIdRemap,
  CanonicalPairScoringResult,
  CanonicalReasonCode,
  CanonicalTrackCluster,
  CanonicalizationConfig,
  CanonicalizationResult,
  RecommendationSourceTrack,
  TitleFlavor,
} from "../types";
import { defaultRecommendationConfig } from "../config/defaultRecommendationConfig";
import { getCoverUrlQualityScore, isPlaceholderCoverUrl, pickBestCoverUrl } from "./coverUrl";
import { recommendationNormalizationService } from "./normalization";
import { getSourcePriority, getSourceTrustScore } from "./sourceMetadata";

const CANONICALIZATION_VERSION = 1;

interface LyricsLike {
  plain?: string;
  synced?: string;
  status?: string;
}

interface CanonicalizationInput {
  searchSetId: string;
  tracks: RecommendationSourceTrack[];
  lyricsByTrackId?: Record<string, LyricsLike>;
  previousResult?: CanonicalizationResult | null;
  canonicalizationRevision: number;
  config?: CanonicalizationConfig;
  includeDebugInfo?: boolean;
}

interface PreparedTrack extends RecommendationSourceTrack {
  normalizedTitle: string;
  normalizedArtistName: string;
  normalizedTitleCore: string;
  normalizedArtistCore: string;
  normalizedTitleSignature: string;
  normalizedArtistSignature: string;
  primaryArtist: string;
  titleFlavor: TitleFlavor[];
  durationBucket: number;
  metadataQualityScore: number;
  sourcePriority: number;
  sourceTrustScore: number;
}

interface PairEvaluation {
  pair: CanonicalPairScoringResult;
  matched: boolean;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  constructor(ids: string[]) {
    ids.forEach((id) => this.parent.set(id, id));
  }

  find(id: string): string {
    const current = this.parent.get(id) ?? id;

    if (current === id) {
      return current;
    }

    const root = this.find(current);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);

    if (leftRoot === rightRoot) {
      return;
    }

    if (leftRoot < rightRoot) {
      this.parent.set(rightRoot, leftRoot);
    } else {
      this.parent.set(leftRoot, rightRoot);
    }
  }
}

function getMedian(values: number[]) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function createDeterministicHash(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0).toString(16);
}

function compareLexical(left: string | undefined | null, right: string | undefined | null) {
  return (left ?? "").localeCompare(right ?? "");
}

function normalizeFlavorSet(flavors: TitleFlavor[]) {
  return [...new Set(flavors.filter((flavor) => flavor !== "versioned_unknown"))].sort();
}

function dedupeStrings(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function getBigrams(value: string) {
  const normalized = value.replace(/\s+/g, "");

  if (normalized.length < 2) {
    return normalized ? [normalized] : [];
  }

  const bigrams: string[] = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    bigrams.push(normalized.slice(index, index + 2));
  }

  return bigrams;
}

function diceCoefficient(left: string, right: string) {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  const leftBigrams = getBigrams(left);
  const rightBigrams = getBigrams(right);

  if (!leftBigrams.length || !rightBigrams.length) {
    return 0;
  }

  const rightCounts = new Map<string, number>();
  rightBigrams.forEach((bigram) => {
    rightCounts.set(bigram, (rightCounts.get(bigram) ?? 0) + 1);
  });

  let intersection = 0;
  leftBigrams.forEach((bigram) => {
    const count = rightCounts.get(bigram) ?? 0;
    if (count <= 0) {
      return;
    }

    rightCounts.set(bigram, count - 1);
    intersection += 1;
  });

  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function limitedLevenshteinDistance(left: string, right: string, limit = 2) {
  if (Math.abs(left.length - right.length) > limit) {
    return limit + 1;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let current = leftIndex;
    let minInRow = current;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const next = Math.min(
        previous[rightIndex] + 1,
        current + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );

      previous[rightIndex - 1] = current;
      current = next;
      minInRow = Math.min(minInRow, next);
    }

    previous[right.length] = current;
    if (minInRow > limit) {
      return limit + 1;
    }
  }

  return previous[right.length];
}

function hasFlavorConflict(left: PreparedTrack, right: PreparedTrack) {
  const leftFlavors = normalizeFlavorSet(left.titleFlavor);
  const rightFlavors = normalizeFlavorSet(right.titleFlavor);

  if (!leftFlavors.length && !rightFlavors.length) {
    return false;
  }

  return leftFlavors.join("|") !== rightFlavors.join("|");
}

function stringSimilarity(left: string, right: string) {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (left.includes(right) || right.includes(left)) {
    return 0.92;
  }

  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const total = new Set([...leftTokens, ...rightTokens]).size;

  const tokenSimilarity = total ? shared / total : 0;
  const bigramSimilarity = diceCoefficient(left, right);
  const editDistance = limitedLevenshteinDistance(left, right, 2);
  const typoSimilarity =
    editDistance === 0
      ? 1
      : editDistance === 1
        ? 0.9
        : editDistance === 2 && Math.max(left.length, right.length) >= 6
          ? 0.78
          : 0;

  return Math.max(tokenSimilarity, bigramSimilarity, typoSimilarity);
}

function isStrongArtistMismatch(left: PreparedTrack, right: PreparedTrack) {
  const coreSimilarity = stringSimilarity(left.normalizedArtistCore, right.normalizedArtistCore);
  const signatureSimilarity = stringSimilarity(
    left.normalizedArtistSignature,
    right.normalizedArtistSignature,
  );

  return Math.max(coreSimilarity, signatureSimilarity) < 0.32;
}

function getDurationDeltaMs(left: RecommendationSourceTrack, right: RecommendationSourceTrack) {
  return Math.abs(left.duration - right.duration) * 1000;
}

function getTrackMetadataQuality(track: PreparedTrack) {
  let score = 0;

  if (track.musicBrainzRecordingId) {
    score += 4;
  }

  if (track.musicBrainzArtistId) {
    score += 2;
  }

  if (track.musicBrainzReleaseId) {
    score += 2;
  }

  if (track.albumTitle) {
    score += 1;
  }

  const coverQualityScore = getCoverUrlQualityScore(track.coverUrl);
  if (coverQualityScore > 0) {
    score += 0.5 + coverQualityScore;
  }

  if (track.releaseDate) {
    score += 0.75;
  }

  if (track.normalizedTitleCore) {
    score += 0.5;
  }

  if (track.normalizedArtistCore) {
    score += 0.5;
  }

  score += track.sourceTrustScore;
  return score;
}

function prepareTrack(track: RecommendationSourceTrack): PreparedTrack {
  const normalized = recommendationNormalizationService.normalizeTrackForCanonicalization(track);

  const prepared = {
    ...track,
    normalizedTitle:
      track.normalizedTitle ?? recommendationNormalizationService.normalizeTrackTitle(track.title),
    normalizedArtistName:
      track.normalizedArtistName ??
      recommendationNormalizationService.normalizeArtistName(track.artist),
    normalizedTitleCore: track.normalizedTitleCore ?? normalized.normalizedTitleCore,
    normalizedArtistCore: track.normalizedArtistCore ?? normalized.normalizedArtistCore,
    normalizedTitleSignature: normalized.normalizedTitleSignature,
    normalizedArtistSignature: normalized.normalizedArtistSignature,
    primaryArtist: track.primaryArtist ?? normalized.primaryArtist,
    titleFlavor: track.titleFlavor?.length ? [...track.titleFlavor].sort() : normalized.titleFlavor,
    durationBucket: normalized.durationBucket,
    sourcePriority: track.sourcePriority ?? getSourcePriority(track.providerId),
    sourceTrustScore: track.sourceTrustScore ?? getSourceTrustScore(track.providerId),
    metadataQualityScore: 0,
  } satisfies PreparedTrack;

  prepared.metadataQualityScore = getTrackMetadataQuality(prepared);
  return prepared;
}

function getSingletonClusterConfidence(track: PreparedTrack) {
  // A singleton cluster has no pairwise merge evidence, so its confidence should
  // reflect stable self-identity rather than collapse to zero. This keeps backend
  // extraction deterministic while allowing low-noise playable singletons through.
  const metadataComponent = Math.min(track.metadataQualityScore / 12.5, 0.18);
  const trustComponent = Math.min(track.sourceTrustScore * 0.12, 0.12);
  const availabilityComponent = track.audioUrl ? 0.04 : 0;
  const enrichmentComponent =
    (track.musicBrainzRecordingId ? 0.1 : 0) +
    (track.musicBrainzArtistId ? 0.06 : 0) +
    (track.musicBrainzReleaseId ? 0.04 : 0);

  return clamp01(0.44 + metadataComponent + trustComponent + availabilityComponent + enrichmentComponent);
}

function buildBlockingKeys(track: PreparedTrack) {
  const keys = new Set<string>();

  if (track.musicBrainzRecordingId) {
    keys.add(`mbrec:${track.musicBrainzRecordingId}`);
  }

  if (track.acoustId) {
    keys.add(`acoustid:${track.acoustId}`);
  }

  if (track.normalizedTitleCore && track.normalizedArtistCore) {
    keys.add(`title-artist:${track.normalizedTitleCore}|${track.normalizedArtistCore}`);
  }

  if (track.normalizedTitleSignature && track.normalizedArtistSignature) {
    keys.add(`signature-artist:${track.normalizedTitleSignature}|${track.normalizedArtistSignature}`);
  }

  if (track.normalizedTitleCore && track.primaryArtist) {
    keys.add(`title-primary:${track.normalizedTitleCore}|${track.primaryArtist}|${track.durationBucket}`);
  }

  if (track.normalizedTitleSignature && track.primaryArtist) {
    keys.add(
      `signature-primary:${track.normalizedTitleSignature}|${track.primaryArtist}|${track.durationBucket}`,
    );
  }

  if (track.normalizedTitleCore) {
    keys.add(`title-duration:${track.normalizedTitleCore}|${track.durationBucket}`);
  }

  if (track.normalizedTitleSignature) {
    keys.add(`signature-duration:${track.normalizedTitleSignature}|${track.durationBucket}`);
  }

  return [...keys].sort();
}

function getThreshold(config: CanonicalizationConfig) {
  return config.enableAggressiveDedup ? config.relaxedMergeThreshold : config.strictMergeThreshold;
}

function dedupeTracksById(tracks: PreparedTrack[]) {
  return [...new Map(tracks.map((track) => [track.id, track])).values()];
}

function buildClusterGroupKey(clusterTracks: PreparedTrack[]) {
  const targetDurationSeconds = getMedian(clusterTracks.map((variant) => variant.duration));
  const preferredVariant = choosePreferredVariant(clusterTracks, targetDurationSeconds);
  const canonicalId = buildCanonicalId(clusterTracks, preferredVariant, targetDurationSeconds);

  if (canonicalId.startsWith("mbrec:") || canonicalId.startsWith("acoustid:")) {
    return canonicalId;
  }

  return `cluster:${clusterTracks[0]?.id ?? canonicalId}`;
}

function evaluatePair(left: PreparedTrack, right: PreparedTrack, config: CanonicalizationConfig): PairEvaluation {
  const reasons: CanonicalReasonCode[] = [];
  const blockers: CanonicalReasonCode[] = [];
  let score = 0;
  const hasSameMbRecordingId =
    !!left.musicBrainzRecordingId && left.musicBrainzRecordingId === right.musicBrainzRecordingId;
  const hasSameAcoustId = !!left.acoustId && left.acoustId === right.acoustId;
  const hasStrongIdentifierMatch = hasSameMbRecordingId || hasSameAcoustId;

  if (
    config.blockOnConflictingMbRecordingIds &&
    left.musicBrainzRecordingId &&
    right.musicBrainzRecordingId &&
    left.musicBrainzRecordingId !== right.musicBrainzRecordingId
  ) {
    blockers.push("conflicting_mb_recording_ids");
  }

  if (
    config.blockOnPrimaryArtistConflict &&
    left.primaryArtist &&
    right.primaryArtist &&
    left.primaryArtist !== right.primaryArtist &&
    isStrongArtistMismatch(left, right) &&
    !hasStrongIdentifierMatch
  ) {
    blockers.push("primary_artist_conflict");
  }

  if (config.blockOnFlavorConflict && hasFlavorConflict(left, right) && !hasStrongIdentifierMatch) {
    blockers.push("flavor_conflict");
    score -= config.titleFlavorConflictPenalty;
  }

  if (hasSameMbRecordingId) {
    reasons.push("same_mb_recording_id");
    score += config.mbRecordingMatchBoost;
  }

  if (hasSameAcoustId) {
    reasons.push("same_acoustid");
    score += config.acoustIdMatchBoost;
  }

  const titleSimilarity = Math.max(
    stringSimilarity(left.normalizedTitleCore, right.normalizedTitleCore),
    stringSimilarity(left.normalizedTitleSignature, right.normalizedTitleSignature),
  );
  const artistSimilarity = Math.max(
    stringSimilarity(left.normalizedArtistCore, right.normalizedArtistCore),
    stringSimilarity(left.normalizedArtistSignature, right.normalizedArtistSignature),
  );

  if (titleSimilarity === 1) {
    reasons.push("title_core_exact");
    score += config.titleExactBoost;
  } else if (titleSimilarity < 0.45) {
    blockers.push("title_too_different");
  } else {
    score += titleSimilarity * config.titleExactBoost;
  }

  if (artistSimilarity === 1) {
    reasons.push("artist_core_exact");
    score += config.artistExactBoost;
  } else if (artistSimilarity < 0.35) {
    score -= config.artistMismatchPenalty;
  } else {
    score += artistSimilarity * config.artistExactBoost;
  }

  const durationDeltaMs = getDurationDeltaMs(left, right);
  const maxDurationDeltaMs = config.enableAggressiveDedup
    ? config.maxDurationDeltaMsRelaxed
    : config.maxDurationDeltaMsStrict;

  if (durationDeltaMs <= maxDurationDeltaMs) {
    reasons.push("duration_close");
    score += 1.5;
  } else if (!hasStrongIdentifierMatch) {
    blockers.push("duration_too_far");
    score -= config.durationMismatchPenalty;
  }

  return {
    pair: {
      leftTrackId: left.id,
      rightTrackId: right.id,
      score,
      reasons: reasons.sort(),
      blockers: blockers.sort(),
    },
    matched: !blockers.length && (hasStrongIdentifierMatch || score >= getThreshold(config)),
  };
}

function buildPairIndex(leftId: string, rightId: string) {
  return leftId < rightId ? `${leftId}::${rightId}` : `${rightId}::${leftId}`;
}

function sortTracksDeterministically(tracks: PreparedTrack[]) {
  return [...tracks].sort((left, right) => {
    if (left.sourcePriority !== right.sourcePriority) {
      return right.sourcePriority - left.sourcePriority;
    }

    if (left.metadataQualityScore !== right.metadataQualityScore) {
      return right.metadataQualityScore - left.metadataQualityScore;
    }

    return compareLexical(left.id, right.id);
  });
}

function getDisplayTextQuality(value: string) {
  if (!value.trim()) {
    return 0;
  }

  let score = 0;

  if (/[A-ZА-ЯЁ]/.test(value)) {
    score += 1;
  }

  if (value !== value.toLowerCase()) {
    score += 0.5;
  }

  if (!/^\s*[\p{L}0-9\s]+\s*$/iu.test(value)) {
    score -= 0.2;
  }

  if (value === value.toLowerCase()) {
    score -= 0.2;
  }

  return score;
}

function selectTrackByField(
  variants: PreparedTrack[],
  fieldValue: (variant: PreparedTrack) => string | number | boolean | null | undefined,
  normalizedKey?: (variant: PreparedTrack) => string | null | undefined,
  fieldScore?: (variant: PreparedTrack) => number,
) {
  const candidates = variants.filter((variant) => {
    const value = fieldValue(variant);
    return value !== undefined && value !== null && `${value}`.trim() !== "";
  });

  const pool = candidates.length ? candidates : variants;
  const keyFrequency = new Map<string, number>();

  if (normalizedKey) {
    pool.forEach((variant) => {
      const key = normalizedKey(variant);
      if (!key) {
        return;
      }

      keyFrequency.set(key, (keyFrequency.get(key) ?? 0) + 1);
    });
  }

  return [...pool].sort((left, right) => {
    const leftHasMb = left.musicBrainzRecordingId ? 1 : 0;
    const rightHasMb = right.musicBrainzRecordingId ? 1 : 0;

    if (leftHasMb !== rightHasMb) {
      return rightHasMb - leftHasMb;
    }

    const leftFieldScore = fieldScore ? fieldScore(left) : 0;
    const rightFieldScore = fieldScore ? fieldScore(right) : 0;
    if (leftFieldScore !== rightFieldScore) {
      return rightFieldScore - leftFieldScore;
    }

    if (left.metadataQualityScore !== right.metadataQualityScore) {
      return right.metadataQualityScore - left.metadataQualityScore;
    }

    if (left.sourcePriority !== right.sourcePriority) {
      return right.sourcePriority - left.sourcePriority;
    }

    const leftFrequency = normalizedKey ? keyFrequency.get(normalizedKey(left) ?? "") ?? 0 : 0;
    const rightFrequency = normalizedKey ? keyFrequency.get(normalizedKey(right) ?? "") ?? 0 : 0;
    if (leftFrequency !== rightFrequency) {
      return rightFrequency - leftFrequency;
    }

    const leftDisplayQuality = getDisplayTextQuality(`${fieldValue(left) ?? ""}`);
    const rightDisplayQuality = getDisplayTextQuality(`${fieldValue(right) ?? ""}`);
    if (leftDisplayQuality !== rightDisplayQuality) {
      return rightDisplayQuality - leftDisplayQuality;
    }

    const leftLength = `${fieldValue(left) ?? ""}`.trim().length;
    const rightLength = `${fieldValue(right) ?? ""}`.trim().length;
    if (leftLength !== rightLength) {
      return rightLength - leftLength;
    }

    const lexicalField = compareLexical(`${fieldValue(left) ?? ""}`, `${fieldValue(right) ?? ""}`);
    if (lexicalField !== 0) {
      return lexicalField;
    }

    return compareLexical(left.id, right.id);
  })[0];
}

function selectCoverVariant(variants: PreparedTrack[]) {
  return selectTrackByField(
    variants,
    (variant) => variant.coverUrl,
    undefined,
    (variant) => getCoverUrlQualityScore(variant.coverUrl),
  );
}

function choosePreferredVariant(variants: PreparedTrack[], targetDuration: number) {
  const medianDuration = targetDuration || getMedian(variants.map((variant) => variant.duration));

  return [...variants].sort((left, right) => {
    const leftPlayable = left.audioUrl ? 1 : 0;
    const rightPlayable = right.audioUrl ? 1 : 0;
    if (leftPlayable !== rightPlayable) {
      return rightPlayable - leftPlayable;
    }

    const leftHasMb = left.musicBrainzRecordingId ? 1 : 0;
    const rightHasMb = right.musicBrainzRecordingId ? 1 : 0;
    if (leftHasMb !== rightHasMb) {
      return rightHasMb - leftHasMb;
    }

    if (left.metadataQualityScore !== right.metadataQualityScore) {
      return right.metadataQualityScore - left.metadataQualityScore;
    }

    const leftDelta = Math.abs(left.duration - medianDuration);
    const rightDelta = Math.abs(right.duration - medianDuration);
    if (leftDelta !== rightDelta) {
      return leftDelta - rightDelta;
    }

    if (left.sourcePriority !== right.sourcePriority) {
      return right.sourcePriority - left.sourcePriority;
    }

    return compareLexical(left.id, right.id);
  })[0];
}

function buildCanonicalId(
  variants: PreparedTrack[],
  preferredVariant: PreparedTrack,
  targetDuration: number,
) {
  const recordingIds = dedupeStrings(
    variants.map((variant) => variant.musicBrainzRecordingId).filter(Boolean) as string[],
  );
  if (recordingIds.length) {
    return `mbrec:${recordingIds[0]}`;
  }

  const acoustIds = dedupeStrings(
    variants.map((variant) => variant.acoustId).filter(Boolean) as string[],
  );
  if (acoustIds.length) {
    return `acoustid:${acoustIds[0]}`;
  }

  const key = [
    preferredVariant.normalizedTitleSignature || preferredVariant.normalizedTitleCore,
    preferredVariant.normalizedArtistSignature || preferredVariant.normalizedArtistCore,
    recommendationNormalizationService.getDurationBucket(targetDuration),
  ].join("|");

  return `soft:${createDeterministicHash(key)}`;
}

function selectCanonicalLyrics(variants: PreparedTrack[], lyricsByTrackId: Record<string, LyricsLike>) {
  const readyLyrics = variants
    .map((variant) => lyricsByTrackId[variant.id])
    .filter((lyrics): lyrics is LyricsLike => !!lyrics && lyrics.status === "ready");

  const preferredLyrics = readyLyrics.find((lyrics) => !!lyrics.synced) ?? readyLyrics[0];
  return preferredLyrics?.synced ?? preferredLyrics?.plain ?? null;
}

function buildRemaps(
  previousResult: CanonicalizationResult | null | undefined,
  nextTracks: CanonicalTrackCluster[],
  nextCanonicalIdByVariantTrackId: Record<string, string>,
): CanonicalIdRemap[] {
  if (!previousResult) {
    return [];
  }

  return Object.values(previousResult.canonicalById)
    .map((previousTrack) => {
      const overlappingNextIds = previousTrack.variantTrackIds.reduce<Record<string, number>>(
        (accumulator, variantTrackId) => {
          const nextCanonicalId = nextCanonicalIdByVariantTrackId[variantTrackId];
          if (!nextCanonicalId) {
            return accumulator;
          }

          accumulator[nextCanonicalId] = (accumulator[nextCanonicalId] ?? 0) + 1;
          return accumulator;
        },
        {},
      );

      const candidates = Object.entries(overlappingNextIds)
        .map(([canonicalId, overlapCount]) => ({
          canonicalId,
          overlapCount,
          includesPreferredVariant: previousTrack.preferredVariantId
            ? nextTracks.find((track) => track.canonicalId === canonicalId)?.variantTrackIds.includes(
                previousTrack.preferredVariantId,
              ) ?? false
            : false,
        }))
        .sort((left, right) => {
          if (left.includesPreferredVariant !== right.includesPreferredVariant) {
            return left.includesPreferredVariant ? -1 : 1;
          }

          if (left.overlapCount !== right.overlapCount) {
            return right.overlapCount - left.overlapCount;
          }

          return compareLexical(left.canonicalId, right.canonicalId);
        });

      const nextCanonicalId = candidates[0]?.canonicalId;
      if (!nextCanonicalId || nextCanonicalId === previousTrack.canonicalId) {
        return null;
      }

      const reason =
        previousTrack.canonicalId.startsWith("soft:") &&
        (nextCanonicalId.startsWith("mbrec:") || nextCanonicalId.startsWith("acoustid:"))
          ? "identifier_upgrade"
          : candidates.length > 1
            ? "cluster_split"
            : "cluster_recompute";

      return {
        fromCanonicalId: previousTrack.canonicalId,
        toCanonicalId: nextCanonicalId,
        searchSetId: previousTrack.searchSetId,
        canonicalizationVersion: previousTrack.canonicalizationVersion,
        canonicalizationRevision:
          nextTracks.find((track) => track.canonicalId === nextCanonicalId)?.canonicalizationRevision ?? 0,
        clusterRevision:
          nextTracks.find((track) => track.canonicalId === nextCanonicalId)?.clusterRevision ?? 0,
        reason,
        variantTrackIds: previousTrack.variantTrackIds,
        occurredAt: new Date().toISOString(),
      } satisfies CanonicalIdRemap;
    })
    .filter((remap): remap is CanonicalIdRemap => !!remap);
}

function buildClusterDebugInfo(
  variants: PreparedTrack[],
  blockingKeys: string[],
  pairScoring: CanonicalPairScoringResult[],
  remaps: CanonicalIdRemap[],
  includeDebugInfo: boolean,
): CanonicalDebugInfo | undefined {
  if (!includeDebugInfo) {
    return undefined;
  }

  const variantTrackIds = new Set(variants.map((variant) => variant.id));
  const relevantPairs = pairScoring
    .filter((pair) => variantTrackIds.has(pair.leftTrackId) && variantTrackIds.has(pair.rightTrackId))
    .sort((left, right) =>
      compareLexical(buildPairIndex(left.leftTrackId, left.rightTrackId), buildPairIndex(right.leftTrackId, right.rightTrackId)),
    );

  return {
    blockingKeys,
    pairScoring: relevantPairs,
    mergeBlockers: dedupeStrings(relevantPairs.flatMap((pair) => pair.blockers) as string[]) as CanonicalReasonCode[],
    clusterReasons: dedupeStrings(relevantPairs.flatMap((pair) => pair.reasons) as string[]) as CanonicalReasonCode[],
    aliasRemapHistory: remaps,
  };
}

export function resolvePlayableTrackId(canonicalTrack: CanonicalTrackCluster) {
  return canonicalTrack.preferredVariantId ?? canonicalTrack.variantTrackIds[0] ?? null;
}

export function buildCanonicalLyricsCacheKey(
  canonicalTrack: Pick<CanonicalTrackCluster, "title" | "artist" | "targetDuration">,
  config: CanonicalizationConfig,
) {
  const durationBucket = recommendationNormalizationService.getDurationBucket(
    canonicalTrack.targetDuration ?? 0,
    config.lyricsDurationBucketMs / 1000,
  );

  return [
    recommendationNormalizationService.normalizeTrackTitleCore(canonicalTrack.title),
    recommendationNormalizationService.normalizeArtistCore(canonicalTrack.artist),
    durationBucket,
  ].join("|");
}

export const recommendationTrackCanonicalizationService = {
  canonicalizationVersion: CANONICALIZATION_VERSION,

  buildCanonicalizationResult({
    searchSetId,
    tracks,
    lyricsByTrackId = {},
    previousResult,
    canonicalizationRevision,
    config,
    includeDebugInfo = true,
  }: CanonicalizationInput): CanonicalizationResult {
    const activeConfig = config ?? defaultRecommendationConfig.canonicalization;

    if (!activeConfig.enableTrackCanonicalization || !tracks.length) {
      return {
        searchSetId,
        canonicalizationVersion: CANONICALIZATION_VERSION,
        canonicalizationRevision,
        canonicalTracks: [],
        canonicalById: {},
        canonicalIdByVariantTrackId: {},
        variantTrackIdsByCanonicalId: {},
        searchCanonicalResultIds: [],
        aliasTargetsByCanonicalId: {},
        remaps: [],
      };
    }

    const preparedTracks = tracks.map(prepareTrack);
    const trackIndexById = new Map(preparedTracks.map((track, index) => [track.id, index]));
    const blocks = new Map<string, PreparedTrack[]>();

    preparedTracks.forEach((track) => {
      buildBlockingKeys(track).forEach((blockingKey) => {
        const existing = blocks.get(blockingKey);
        if (existing) {
          existing.push(track);
        } else {
          blocks.set(blockingKey, [track]);
        }
      });
    });

    const pairEvaluations = new Map<string, CanonicalPairScoringResult>();
    const matchedEdges: Array<{ leftTrackId: string; rightTrackId: string }> = [];

    [...blocks.entries()]
      .sort(([leftKey], [rightKey]) => compareLexical(leftKey, rightKey))
      .forEach(([, blockTracks]) => {
        const sortedBlock = sortTracksDeterministically(blockTracks);

        for (let leftIndex = 0; leftIndex < sortedBlock.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < sortedBlock.length; rightIndex += 1) {
            const left = sortedBlock[leftIndex];
            const right = sortedBlock[rightIndex];
            const pairIndex = buildPairIndex(left.id, right.id);

            if (pairEvaluations.has(pairIndex)) {
              continue;
            }

            const evaluation = evaluatePair(left, right, activeConfig);
            pairEvaluations.set(pairIndex, evaluation.pair);

            if (evaluation.matched) {
              matchedEdges.push({ leftTrackId: left.id, rightTrackId: right.id });
            }
          }
        }
      });

    const disjointSet = new DisjointSet(preparedTracks.map((track) => track.id));
    matchedEdges
      .sort((left, right) =>
        compareLexical(buildPairIndex(left.leftTrackId, left.rightTrackId), buildPairIndex(right.leftTrackId, right.rightTrackId)),
      )
      .forEach((edge) => disjointSet.union(edge.leftTrackId, edge.rightTrackId));

    const clusters = new Map<string, PreparedTrack[]>();
    preparedTracks.forEach((track) => {
      const clusterId = disjointSet.find(track.id);
      const existing = clusters.get(clusterId);
      if (existing) {
        existing.push(track);
      } else {
        clusters.set(clusterId, [track]);
      }
    });

    const mergedClusterVariants = [...clusters.values()].reduce<PreparedTrack[][]>((accumulator, clusterTracks) => {
      const sortedCluster = sortTracksDeterministically(clusterTracks);
      const groupKey = buildClusterGroupKey(sortedCluster);
      const existingGroup = accumulator.find(
        (variants) => buildClusterGroupKey(sortTracksDeterministically(variants)) === groupKey,
      );

      if (existingGroup) {
        existingGroup.push(...sortedCluster);
      } else {
        accumulator.push([...sortedCluster]);
      }

      return accumulator;
    }, []);

    const canonicalTracks = mergedClusterVariants
      .map((variants) => dedupeTracksById(sortTracksDeterministically(variants)))
      .map((clusterTracks) => {
        const variants = sortTracksDeterministically(clusterTracks);
        const targetDurationSeconds = getMedian(variants.map((variant) => variant.duration));
        const preferredVariant = choosePreferredVariant(variants, targetDurationSeconds);
        const canonicalId = buildCanonicalId(variants, preferredVariant, targetDurationSeconds);
        const titleVariant = selectTrackByField(
          variants,
          (variant) => variant.title,
          (variant) => variant.normalizedTitleSignature || variant.normalizedTitleCore,
        );
        const artistVariant = selectTrackByField(
          variants,
          (variant) => variant.artist,
          (variant) => variant.normalizedArtistSignature || variant.normalizedArtistCore,
        );
        const albumVariant = selectTrackByField(variants, (variant) => variant.albumTitle);
        const coverVariant = selectCoverVariant(variants);
        const explicitVariant = selectTrackByField(variants, (variant) => variant.explicit);
        const musicBrainzVariant = selectTrackByField(variants, (variant) => variant.musicBrainzRecordingId);
        const variantTrackIds = variants.map((variant) => variant.id).sort(compareLexical);
        const blockingKeys = dedupeStrings(variants.flatMap((variant) => buildBlockingKeys(variant)));
        const clusterPairs = [...pairEvaluations.values()];
        const clusterConfidence =
          variants.length === 1
            ? getSingletonClusterConfidence(preferredVariant)
            : clamp01(
                clusterPairs
                  .filter(
                    (pair) => variantTrackIds.includes(pair.leftTrackId) && variantTrackIds.includes(pair.rightTrackId),
                  )
                  .reduce((accumulator, pair) => accumulator + Math.max(pair.score, 0), 0) /
                  Math.max(variantTrackIds.length * 12, 1),
              );

        return {
          canonicalId,
          searchSetId,
          canonicalizationVersion: CANONICALIZATION_VERSION,
          canonicalizationRevision,
          clusterRevision: canonicalizationRevision,
          title: titleVariant.title,
          artist: artistVariant.artist,
          album: albumVariant.albumTitle ?? null,
          coverUrl:
            pickBestCoverUrl(
              coverVariant.coverUrl,
              variants.find((variant) => !isPlaceholderCoverUrl(variant.coverUrl))?.coverUrl,
            ) || null,
          lyrics: selectCanonicalLyrics(variants, lyricsByTrackId),
          explicit: explicitVariant.explicit ?? null,
          normalizedTitleCore: titleVariant.normalizedTitleCore ?? null,
          normalizedArtistCore: artistVariant.normalizedArtistCore ?? null,
          primaryArtist: artistVariant.primaryArtist ?? null,
          titleFlavor: dedupeStrings(variants.flatMap((variant) => variant.titleFlavor)) as TitleFlavor[],
          targetDuration: targetDurationSeconds,
          variantTrackIds,
          preferredVariantId: preferredVariant.id,
          musicBrainzRecordingId: musicBrainzVariant.musicBrainzRecordingId ?? null,
          musicBrainzArtistId: musicBrainzVariant.musicBrainzArtistId ?? null,
          musicBrainzReleaseId: musicBrainzVariant.musicBrainzReleaseId ?? null,
          musicBrainzReleaseGroupId: musicBrainzVariant.musicBrainzReleaseGroupId ?? null,
          acoustId: variants.find((variant) => !!variant.acoustId)?.acoustId ?? null,
          provenance: {
            title: titleVariant.id,
            artist: artistVariant.id,
            album: albumVariant.id,
            coverUrl: coverVariant.id,
            lyrics: variants.find((variant) => !!lyricsByTrackId[variant.id])?.id,
            targetDuration: preferredVariant.id,
            preferredVariantId: preferredVariant.id,
          },
          quality: {
            clusterConfidence,
            dedupReason: dedupeStrings(
              clusterPairs
                .filter(
                  (pair) =>
                    variantTrackIds.includes(pair.leftTrackId) &&
                    variantTrackIds.includes(pair.rightTrackId),
                )
                .flatMap((pair) => pair.reasons) as string[],
            ) as CanonicalReasonCode[],
            lastComputedAt: new Date().toISOString(),
            sourcePriority: preferredVariant.sourcePriority,
            sourceTrustScore: preferredVariant.sourceTrustScore,
          },
          debugInfo: buildClusterDebugInfo(
            variants,
            blockingKeys,
            [...pairEvaluations.values()],
            [],
            includeDebugInfo,
          ),
        } satisfies CanonicalTrackCluster;
      })
      .sort((left, right) => {
        const leftMinIndex = Math.min(
          ...left.variantTrackIds.map((trackId) => trackIndexById.get(trackId) ?? Number.MAX_SAFE_INTEGER),
        );
        const rightMinIndex = Math.min(
          ...right.variantTrackIds.map((trackId) => trackIndexById.get(trackId) ?? Number.MAX_SAFE_INTEGER),
        );

        if (leftMinIndex !== rightMinIndex) {
          return leftMinIndex - rightMinIndex;
        }

        return compareLexical(left.canonicalId, right.canonicalId);
      });

    const canonicalById = Object.fromEntries(
      canonicalTracks.map((track) => [track.canonicalId, track]),
    ) as Record<string, CanonicalTrackCluster>;
    const canonicalIdByVariantTrackId = Object.fromEntries(
      canonicalTracks.flatMap((track) =>
        track.variantTrackIds.map((variantTrackId) => [variantTrackId, track.canonicalId]),
      ),
    ) as Record<string, string>;
    const variantTrackIdsByCanonicalId = Object.fromEntries(
      canonicalTracks.map((track) => [track.canonicalId, track.variantTrackIds]),
    ) as Record<string, string[]>;
    const remaps = buildRemaps(previousResult, canonicalTracks, canonicalIdByVariantTrackId);
    const uniqueSearchCanonicalResultIds = [...new Set(canonicalTracks.map((track) => track.canonicalId))];
    const aliasTargetsByCanonicalId = Object.fromEntries(
      remaps.map((remap) => [
        remap.fromCanonicalId,
        {
          canonicalId: remap.toCanonicalId,
          searchSetId: remap.searchSetId,
          canonicalizationVersion: remap.canonicalizationVersion,
          canonicalizationRevision: remap.canonicalizationRevision,
          clusterRevision: remap.clusterRevision,
          reason: remap.reason,
        },
      ]),
    ) as CanonicalizationResult["aliasTargetsByCanonicalId"];

    canonicalTracks.forEach((track) => {
      if (track.debugInfo) {
        track.debugInfo.aliasRemapHistory = remaps.filter((remap) => remap.toCanonicalId === track.canonicalId);
      }
    });

    return {
      searchSetId,
      canonicalizationVersion: CANONICALIZATION_VERSION,
      canonicalizationRevision,
      canonicalTracks,
      canonicalById,
      canonicalIdByVariantTrackId,
      variantTrackIdsByCanonicalId,
      searchCanonicalResultIds: uniqueSearchCanonicalResultIds,
      aliasTargetsByCanonicalId,
      remaps,
    };
  },
};
