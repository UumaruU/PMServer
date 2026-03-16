// Pure domain logic: recommendation types and ports live here and do not depend on app/UI types.

export type RecommendationProviderId = string;
export type RecommendationEntityType = "artist" | "track" | "release" | "tag";
export type RecommendationTagType =
  | "genre"
  | "subgenre"
  | "mood"
  | "scene"
  | "era"
  | "region"
  | "instrumentation"
  | "vocal_style"
  | "language"
  | "theme"
  | "activity"
  | "audio_trait";
export type RecommendationRelationType =
  | "collaborated_with"
  | "featured_with"
  | "member_of"
  | "side_project_of"
  | "producer_for"
  | "remixer_of"
  | "similar_to";
export type RecommendationTrackArtistRole =
  | "primary"
  | "featured"
  | "remixer"
  | "producer"
  | "composer"
  | "contributor";
export type TitleFlavor =
  | "original"
  | "live"
  | "acoustic"
  | "instrumental"
  | "karaoke"
  | "remix"
  | "edit"
  | "radio_edit"
  | "extended"
  | "demo"
  | "cover"
  | "versioned_unknown";
export type RecommendationMode =
  | "next-track"
  | "track-radio"
  | "artist-radio"
  | "autoplay"
  | "related-tracks"
  | "related-artists";
export type RecommendationChannel =
  | "sameArtist"
  | "frequentCollaborators"
  | "relatedArtists"
  | "sharedTags"
  | "releaseEraProximity"
  | "sessionContinuation"
  | "userAffinityRetrieval";

export interface CanonicalizationConfig {
  strictMergeThreshold: number;
  relaxedMergeThreshold: number;
  maxDurationDeltaMsStrict: number;
  maxDurationDeltaMsRelaxed: number;
  titleExactBoost: number;
  artistExactBoost: number;
  mbRecordingMatchBoost: number;
  acoustIdMatchBoost: number;
  titleFlavorConflictPenalty: number;
  artistMismatchPenalty: number;
  durationMismatchPenalty: number;
  blockOnFlavorConflict: boolean;
  blockOnConflictingMbRecordingIds: boolean;
  blockOnPrimaryArtistConflict: boolean;
  enableTrackCanonicalization: boolean;
  enableAggressiveDedup: boolean;
  enableFingerprintFallback: boolean;
  lyricsDurationBucketMs: number;
  minCanonicalConfidenceForLyricsReuse: number;
  sourcePriorityByProvider: Record<RecommendationProviderId, number>;
  sourceTrustByProvider: Record<RecommendationProviderId, number>;
}

export interface RecommendationSourceTrack {
  id: string;
  providerId: RecommendationProviderId;
  providerTrackId?: string;
  title: string;
  artist: string;
  coverUrl: string;
  audioUrl: string;
  duration: number;
  sourceUrl: string;
  isFavorite: boolean;
  downloadState?: string;
  localPath?: string;
  downloadError?: string;
  musicBrainzRecordingId?: string | null;
  musicBrainzArtistId?: string | null;
  musicBrainzReleaseId?: string | null;
  musicBrainzReleaseGroupId?: string | null;
  normalizedTitle?: string;
  normalizedArtistName?: string;
  metadataStatus?: string;
  albumTitle?: string;
  releaseDate?: string;
  explicit?: boolean | null;
  normalizedTitleCore?: string;
  normalizedArtistCore?: string;
  primaryArtist?: string;
  titleFlavor?: TitleFlavor[];
  canonicalId?: string;
  acoustId?: string | null;
  fingerprintStatus?: string;
  sourceTrustScore?: number;
  sourcePriority?: number;
}

export interface RecommendationSourceArtist {
  id: string;
  name: string;
  musicBrainzArtistId?: string | null;
  type?: string;
  country?: string;
  area?: string;
  beginArea?: string;
  disambiguation?: string;
  beginDate?: string;
  endDate?: string;
  tags?: string[];
  imageUrl?: string;
}

export interface RecommendationSourceRelease {
  id: string;
  title: string;
  musicBrainzReleaseId?: string | null;
  musicBrainzReleaseGroupId?: string | null;
  artistId?: string;
  artistName?: string;
  kind?: "album" | "single" | "other";
  date?: string;
  country?: string;
  coverUrl?: string;
  trackTitles?: string[];
  trackIds?: string[];
}

export interface RecommendationSourceProviderMetadata {
  providerId: RecommendationProviderId;
  sourcePriority?: number;
  sourceTrustScore?: number;
  popularityPrior?: number;
}

export interface CanonicalIdRemap {
  fromCanonicalId: string;
  toCanonicalId: string;
  searchSetId: string;
  canonicalizationVersion: number;
  canonicalizationRevision: number;
  clusterRevision: number;
  reason: "identifier_upgrade" | "cluster_split" | "cluster_recompute";
  variantTrackIds: string[];
  occurredAt: string;
}

export type CanonicalReasonCode =
  | "same_mb_recording_id"
  | "same_acoustid"
  | "title_core_exact"
  | "artist_core_exact"
  | "duration_close"
  | "flavor_conflict"
  | "conflicting_mb_recording_ids"
  | "primary_artist_conflict"
  | "duration_too_far"
  | "title_too_different";

export interface CanonicalPairScoringResult {
  leftTrackId: string;
  rightTrackId: string;
  score: number;
  reasons: CanonicalReasonCode[];
  blockers: CanonicalReasonCode[];
}

export interface CanonicalDebugInfo {
  blockingKeys: string[];
  pairScoring: CanonicalPairScoringResult[];
  mergeBlockers: CanonicalReasonCode[];
  clusterReasons: CanonicalReasonCode[];
  aliasRemapHistory: CanonicalIdRemap[];
}

export interface CanonicalTrackCluster {
  canonicalId: string;
  searchSetId: string;
  canonicalizationVersion: number;
  canonicalizationRevision: number;
  clusterRevision: number;
  title: string;
  artist: string;
  album?: string | null;
  coverUrl?: string | null;
  lyrics?: string | null;
  explicit?: boolean | null;
  normalizedTitleCore?: string | null;
  normalizedArtistCore?: string | null;
  primaryArtist?: string | null;
  titleFlavor: TitleFlavor[];
  targetDuration?: number | null;
  variantTrackIds: string[];
  preferredVariantId?: string | null;
  musicBrainzRecordingId?: string | null;
  musicBrainzArtistId?: string | null;
  musicBrainzReleaseId?: string | null;
  musicBrainzReleaseGroupId?: string | null;
  acoustId?: string | null;
  provenance?: {
    title?: string;
    artist?: string;
    album?: string;
    coverUrl?: string;
    lyrics?: string;
    targetDuration?: string;
    preferredVariantId?: string;
  };
  quality?: {
    clusterConfidence?: number;
    dedupReason?: CanonicalReasonCode[];
    lastComputedAt?: string;
    sourcePriority?: number;
    sourceTrustScore?: number;
  };
  debugInfo?: CanonicalDebugInfo;
}

export interface CanonicalizationResult {
  searchSetId: string;
  canonicalizationVersion: number;
  canonicalizationRevision: number;
  canonicalTracks: CanonicalTrackCluster[];
  canonicalById: Record<string, CanonicalTrackCluster>;
  canonicalIdByVariantTrackId: Record<string, string>;
  variantTrackIdsByCanonicalId: Record<string, string[]>;
  searchCanonicalResultIds: string[];
  aliasTargetsByCanonicalId: Record<
    string,
    {
      canonicalId: string;
      searchSetId: string;
      canonicalizationVersion: number;
      canonicalizationRevision: number;
      clusterRevision: number;
      reason: "identifier_upgrade" | "cluster_split" | "cluster_recompute";
    }
  >;
  remaps: CanonicalIdRemap[];
}

export interface WeightedEdge {
  leftId: string;
  rightId: string;
  weight: number;
  source: RecommendationProviderId | "derived";
  confidence: number;
  reason: string;
}

export interface TagEvidence {
  subjectType: RecommendationEntityType;
  subjectCanonicalId: string;
  rawTag: string;
  canonicalTagId: string;
  source: RecommendationProviderId | "derived";
  sourceTrust: number;
  extractionMethod: string;
  confidence: number;
  weight: number;
}

export interface ArtistRelationEvidence {
  leftCanonicalArtistId: string;
  rightCanonicalArtistId: string;
  relationType: RecommendationRelationType;
  source: RecommendationProviderId | "derived";
  sourceTrust: number;
  confidence: number;
  trackIds: string[];
  releaseIds: string[];
  weight: number;
}

export interface TrackSourceEvidence {
  canonicalTrackId: string;
  provider: RecommendationProviderId;
  rawTrackId: string;
  rawTitle: string;
  rawArtist: string;
  playable: boolean;
  duration: number;
  confidence: number;
}

export interface CanonicalTag {
  canonicalTagId: string;
  slug: string;
  displayName: string;
  aliases: string[];
  tagType: RecommendationTagType;
  parentTagId?: string | null;
  normalizedForm: string;
  sourceEvidence: TagEvidence[];
  quality: {
    confidence: number;
    trustScore: number;
  };
}

export interface CanonicalArtist {
  canonicalArtistId: string;
  musicBrainzArtistId?: string | null;
  name: string;
  normalizedName: string;
  aliases: string[];
  country?: string | null;
  type?: string | null;
  tagIds: string[];
  tagWeights: Record<string, number>;
  relatedArtistIds: string[];
  frequentCollaboratorIds: string[];
  releaseIds: string[];
  trackIds: string[];
  sourceEvidence: ArtistRelationEvidence[];
  quality: {
    confidence: number;
    trustScore: number;
    metadataCompleteness: number;
  };
  debugInfo?: Record<string, unknown>;
}

export interface CanonicalRelease {
  canonicalReleaseId: string;
  musicBrainzReleaseId?: string | null;
  musicBrainzReleaseGroupId?: string | null;
  title: string;
  canonicalArtistIds: string[];
  releaseType?: "album" | "single" | "other";
  year?: number | null;
  labelIds: string[];
  coverUrl?: string | null;
  trackIds: string[];
  tagIds: string[];
  sourceEvidence: TrackSourceEvidence[];
  quality: {
    confidence: number;
    trustScore: number;
    metadataCompleteness: number;
  };
}

export interface CanonicalTrack {
  canonicalTrackId: string;
  musicBrainzRecordingId?: string | null;
  acoustId?: string | null;
  title: string;
  normalizedTitleCore: string;
  titleFlavor: TitleFlavor[];
  canonicalArtistIds: string[];
  primaryCanonicalArtistId?: string | null;
  featuringCanonicalArtistIds: string[];
  canonicalReleaseId?: string | null;
  year?: number | null;
  labelIds: string[];
  language?: string | null;
  explicit?: boolean | null;
  targetDurationMs?: number | null;
  tagIds: string[];
  tagWeights: Record<string, number>;
  preferredVariantId?: string | null;
  playableVariantIds: string[];
  sourceEvidence: TrackSourceEvidence[];
  quality: {
    clusterConfidence: number;
    trustScore: number;
    metadataCompleteness: number;
    popularityPrior: number;
  };
  debugInfo?: Record<string, unknown>;
}

export interface RecommendationCatalogSnapshot {
  snapshotRevision: string;
  generatedAt: string;
  canonicalizationVersion: number;
  canonicalizationRevision: number;
  tracksById: Record<string, CanonicalTrack>;
  artistsById: Record<string, CanonicalArtist>;
  releasesById: Record<string, CanonicalRelease>;
  tagsById: Record<string, CanonicalTag>;
  canonicalIdByVariantTrackId: Record<string, string>;
  artistToTracks: Record<string, string[]>;
  releaseToTracks: Record<string, string[]>;
  trackToArtists: Record<string, string[]>;
  artistToReleases: Record<string, string[]>;
  artistRelations: Record<string, WeightedEdge[]>;
  relatedArtists: Record<string, WeightedEdge[]>;
  tagToTracks: Record<string, string[]>;
  tagToArtists: Record<string, string[]>;
  releaseAdjacency: Record<string, string[]>;
  playableVariantsByCanonicalTrackId: Record<string, string[]>;
}

export interface AffinityEntry {
  value: number;
  updatedAt: string;
  eventCount: number;
}

export interface LongTermTasteProfile {
  updatedAt: string;
  artistAffinities: Record<string, AffinityEntry>;
  tagAffinities: Record<string, AffinityEntry>;
  collaboratorAffinities: Record<string, AffinityEntry>;
  releaseAffinities: Record<string, AffinityEntry>;
  flavorAffinities: Record<string, AffinityEntry>;
  languageAffinities: Record<string, AffinityEntry>;
  eraAffinities: Record<string, AffinityEntry>;
}

export interface SessionTasteProfile {
  sessionId: string;
  updatedAt: string;
  recentTrackIds: string[];
  recentArtistIds: string[];
  recentTagIds: string[];
  recentRecommendationIds: string[];
  recentSkippedTrackIds: string[];
  recentFavoritedTrackIds: string[];
  recentDislikedTrackIds: string[];
  dominantMoodTagId?: string | null;
  dominantGenreTagId?: string | null;
  dominantFlavor?: TitleFlavor | null;
  dominantDurationMs?: number | null;
  channelPenalties: Record<RecommendationChannel, number>;
  replayCountByTrackId: Record<string, number>;
  replayCountByArtistId: Record<string, number>;
}

export interface EntityAffinityProfile {
  updatedAt: string;
  trackAffinities: Record<string, AffinityEntry>;
  artistAffinities: Record<string, AffinityEntry>;
  tagAffinities: Record<string, AffinityEntry>;
  releaseAffinities: Record<string, AffinityEntry>;
  collaboratorAffinities: Record<string, AffinityEntry>;
  dislikedTrackIds: string[];
}

export interface RecommendationProfiles {
  longTerm: LongTermTasteProfile;
  session: SessionTasteProfile;
  entity: EntityAffinityProfile;
}

export interface RecommendationSeed {
  mode: RecommendationMode;
  canonicalTrackId?: string;
  canonicalArtistId?: string;
  canonicalReleaseId?: string;
  seedTrackIds?: string[];
}

export interface RecommendationContext {
  mode: RecommendationMode;
  currentCanonicalTrackId?: string | null;
  currentPrimaryArtistId?: string | null;
  currentFeaturedArtistIds: string[];
  currentTrackTagIds: string[];
  currentArtistTagIds: string[];
  currentReleaseId?: string | null;
  currentFlavor?: TitleFlavor | null;
  currentDurationMs?: number | null;
  recentTrackIds: string[];
  recentArtistIds: string[];
  recentTagCloud: Record<string, number>;
  recentRecommendationIds: string[];
  skippedTrackIds: string[];
  favoritedTrackIds: string[];
  longTermTasteProfile?: LongTermTasteProfile;
  sessionTasteProfile?: SessionTasteProfile;
}

export interface ScoreBreakdown {
  sameArtistScore: number;
  collaboratorScore: number;
  relatedArtistScore: number;
  tagOverlapScore: number;
  sessionFitScore: number;
  releaseProximityScore: number;
  tasteAffinityScore: number;
  durationFitScore: number;
  flavorFitScore: number;
  qualityScore: number;
  availabilityScore: number;
  popularityPriorScore: number;
  noveltyScore: number;
  finalScore: number;
}

export interface PenaltyBreakdown {
  repetitionPenalty: number;
  duplicatePenalty: number;
  skipPenalty: number;
  explicitMismatchPenalty: number;
  totalPenalty: number;
}

export interface RecommendationCandidate {
  canonicalTrackId: string;
  sourceChannels: RecommendationChannel[];
  channelWeights: Partial<Record<RecommendationChannel, number>>;
  mergedEvidence: Array<Record<string, unknown>>;
  baseScore: number;
  scoreBreakdown?: ScoreBreakdown;
  penaltiesApplied?: PenaltyBreakdown;
}

export interface RecommendationExplanation {
  canonicalTrackId: string;
  preferredVariantId: string;
  sourceChannels: RecommendationChannel[];
  scoreBreakdown: ScoreBreakdown;
  topReasons: string[];
  penaltiesApplied: PenaltyBreakdown;
  suppressedCompetitors: Array<{
    canonicalTrackId: string;
    finalScore: number;
  }>;
  relevantTags: string[];
  relevantArtists: string[];
}

export interface RecommendedTrack {
  canonicalTrackId: string;
  preferredVariantId: string;
  sourceChannels: RecommendationChannel[];
  score: number;
  explanation: RecommendationExplanation;
}

export interface RecommendedArtist {
  canonicalArtistId: string;
  score: number;
  sourceChannels: RecommendationChannel[];
  topReasons: string[];
  scoreBreakdown: Record<string, number>;
}

export interface PlaybackAffinityEvent {
  canonicalTrackId: string;
  listenedMs: number;
  trackDurationMs: number;
  occurredAt: string;
  endedNaturally: boolean;
  wasSkipped: boolean;
  sessionId: string;
  seedChannels: RecommendationChannel[];
}

export interface FavoriteAffinityEvent {
  canonicalTrackId: string;
  occurredAt: string;
  isFavorite: boolean;
}

export interface PlaylistAffinityEvent {
  canonicalTrackId: string;
  playlistId: string;
  occurredAt: string;
  isAdded: boolean;
}

export interface DislikeAffinityEvent {
  canonicalTrackId: string;
  occurredAt: string;
  isDisliked: boolean;
}

export interface ProviderFieldTrust {
  identity: number;
  releaseMetadata: number;
  tags: number;
  collaboration: number;
  playback: number;
  popularityPrior: number;
}

export interface RecommendationProviderDefinition {
  providerId: RecommendationProviderId;
  tier: "primary" | "secondary" | "scrape" | "playback-only";
  supportedEntityTypes: RecommendationEntityType[];
  roles: string[];
  fieldTrust: ProviderFieldTrust;
  mergePriority: number;
  precisionBias: "strict" | "balanced";
}

export interface RecommendationScoringWeights {
  sameArtist: number;
  collaborator: number;
  relatedArtist: number;
  tagOverlap: number;
  sessionFit: number;
  releaseProximity: number;
  tasteAffinity: number;
  durationFit: number;
  flavorFit: number;
  quality: number;
  availability: number;
  popularityPrior: number;
  novelty: number;
  repetitionPenalty: number;
  duplicatePenalty: number;
  skipPenalty: number;
  explicitMismatchPenalty: number;
}

export interface RecommendationConfig {
  canonicalization: CanonicalizationConfig;
  providers: Record<RecommendationProviderId, RecommendationProviderDefinition>;
  candidatePoolSizes: Record<RecommendationChannel, number>;
  scoringWeights: RecommendationScoringWeights;
  completionThresholds: {
    strongNegative: number;
    negative: number;
    neutral: number;
    moderatePositive: number;
    strongPositive: number;
    veryStrongPositive: number;
  };
  coldStart: {
    weakHistoryTrackCount: number;
  };
  decay: {
    sessionHalfLifeMs: number;
    longTermHalfLifeMs: number;
    playlistHalfLifeMs: number;
    favoriteHalfLifeMs: number;
    dislikeHalfLifeMs: number;
  };
  filtering: {
    minCanonicalConfidence: number;
  };
  diversification: {
    sameArtistStreak: number;
    sameReleaseStreak: number;
    sameNarrowTagClusterStreak: number;
    repeatedFeaturedArtistLoopThreshold: number;
    maxPenaltyShare: number;
  };
  autoplay: {
    sessionCentroidWindowSize: number;
  };
}

export interface CanonicalCatalogReader {
  getSnapshot(): Promise<RecommendationCatalogSnapshot>;
}

export interface UserHistoryReader {
  getRecentHistory(): Promise<
    Array<{
      trackId: string;
      listenedAt: string;
    }>
  >;
}

export interface FavoritesReader {
  getFavoriteTrackIds(): Promise<string[]>;
}

export interface PlaylistsReader {
  getPlaylists(): Promise<
    Array<{
      id: string;
      trackIds: string[];
      createdAt?: string;
      updatedAt?: string;
    }>
  >;
}

export interface PlayableVariantReader {
  getPlayableVariantIds(canonicalTrackId: string): Promise<string[]>;
  resolvePreferredVariantId(canonicalTrackId: string): Promise<string | null>;
}

export interface ProviderMetadataReader {
  getProviderMetadata(): Promise<Record<RecommendationProviderId, RecommendationSourceProviderMetadata>>;
}

export interface RecommendationCacheStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface RecommendationResultWriter {
  writeTrackResult(input: {
    context: RecommendationContext;
    result: RecommendedTrack | null;
  }): Promise<void>;
  writeTrackRanking(input: {
    seed: RecommendationSeed;
    context: RecommendationContext;
    results: RecommendedTrack[];
  }): Promise<void>;
  writeArtistRanking(input: {
    seed: RecommendationSeed;
    context: RecommendationContext;
    results: RecommendedArtist[];
  }): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface RecommendationEngineDependencies {
  catalogReader: CanonicalCatalogReader;
  userHistoryReader: UserHistoryReader;
  favoritesReader: FavoritesReader;
  playlistsReader: PlaylistsReader;
  playableVariantReader: PlayableVariantReader;
  providerMetadataReader: ProviderMetadataReader;
  cacheStore: RecommendationCacheStore;
  resultWriter: RecommendationResultWriter;
  clock: Clock;
}

export interface RecommendationEngine {
  getNextRecommendedTrack(context: RecommendationContext): Promise<RecommendedTrack | null>;
  getRecommendedTracks(
    seed: RecommendationSeed,
    context: RecommendationContext,
  ): Promise<RecommendedTrack[]>;
  getRecommendedArtists(
    seed: RecommendationSeed,
    context: RecommendationContext,
  ): Promise<RecommendedArtist[]>;
  updateAffinityFromPlayback(event: PlaybackAffinityEvent): Promise<void>;
  updateAffinityFromFavorite(event: FavoriteAffinityEvent): Promise<void>;
  updateAffinityFromPlaylist(event: PlaylistAffinityEvent): Promise<void>;
  updateAffinityFromDislike(event: DislikeAffinityEvent): Promise<void>;
}
