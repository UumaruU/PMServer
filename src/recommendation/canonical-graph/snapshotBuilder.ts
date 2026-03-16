import { buildArtistRelationGraph, extractArtistRelations, inferRelationTypeFromArtistText } from "../collaboration/extractRelations";
import { buildCanonicalTags } from "../tag-normalization/tagNormalization";
import {
  CanonicalArtist,
  CanonicalRelease,
  CanonicalTrack,
  RecommendationCatalogSnapshot,
  RecommendationConfig,
  RecommendationSourceArtist,
  RecommendationSourceProviderMetadata,
  RecommendationSourceRelease,
  RecommendationSourceTrack,
  TagEvidence,
  WeightedEdge,
} from "../types";
import { recommendationNormalizationService } from "./normalization";
import { recommendationTrackCanonicalizationService } from "./trackCanonicalization";

function compareLexical(left: string | undefined | null, right: string | undefined | null) {
  return (left ?? "").localeCompare(right ?? "");
}

function createDeterministicHash(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0).toString(16);
}

function parseYear(date: string | undefined) {
  if (!date) {
    return null;
  }

  const match = date.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function extractArtistNames(artistText: string) {
  return artistText
    .split(/\b(?:feat|ft|featuring|with|x|&|vs)\b|,|;/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildArtistLookup(sources: RecommendationSourceArtist[]) {
  const byId = new Map<string, RecommendationSourceArtist>();
  const byMusicBrainzId = new Map<string, RecommendationSourceArtist>();
  const byNormalizedName = new Map<string, RecommendationSourceArtist>();

  sources.forEach((artist) => {
    byId.set(artist.id, artist);
    if (artist.musicBrainzArtistId) {
      byMusicBrainzId.set(artist.musicBrainzArtistId, artist);
    }

    byNormalizedName.set(recommendationNormalizationService.normalizeArtistCore(artist.name), artist);
  });

  return {
    byId,
    byMusicBrainzId,
    byNormalizedName,
  };
}

function buildReleaseLookup(releases: RecommendationSourceRelease[]) {
  const byId = new Map<string, RecommendationSourceRelease>();
  const byMusicBrainzId = new Map<string, RecommendationSourceRelease>();
  releases.forEach((release) => {
    byId.set(release.id, release);
    if (release.musicBrainzReleaseId) {
      byMusicBrainzId.set(release.musicBrainzReleaseId, release);
    }
  });
  return { byId, byMusicBrainzId };
}

function buildArtistId(rawArtistName: string, musicBrainzArtistId?: string | null) {
  if (musicBrainzArtistId) {
    return `artist:${musicBrainzArtistId}`;
  }

  const normalized = recommendationNormalizationService.normalizeArtistCore(rawArtistName);
  return `artist:soft:${createDeterministicHash(normalized)}`;
}

function buildReleaseId(clusterTitle: string, musicBrainzReleaseId?: string | null) {
  if (musicBrainzReleaseId) {
    return `release:${musicBrainzReleaseId}`;
  }

  const normalized = recommendationNormalizationService.normalizeTrackTitle(clusterTitle);
  return `release:soft:${createDeterministicHash(normalized)}`;
}

function buildSnapshotRevision(parts: {
  tracks: RecommendationSourceTrack[];
  artists: RecommendationSourceArtist[];
  releases: RecommendationSourceRelease[];
}) {
  const payload = [
    parts.tracks
      .map((track) => `${track.id}:${track.metadataStatus ?? ""}:${track.musicBrainzRecordingId ?? ""}:${track.audioUrl ? "1" : "0"}`)
      .sort()
      .join("|"),
    parts.artists.map((artist) => `${artist.id}:${artist.name}:${(artist.tags ?? []).join(",")}`).sort().join("|"),
    parts.releases.map((release) => `${release.id}:${release.title}:${release.date ?? ""}`).sort().join("|"),
  ].join("::");

  return `snapshot:${createDeterministicHash(payload)}`;
}

function computeWeightedJaccard(left: Record<string, number>, right: Record<string, number>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let numerator = 0;
  let denominator = 0;

  keys.forEach((key) => {
    const leftWeight = left[key] ?? 0;
    const rightWeight = right[key] ?? 0;
    numerator += Math.min(leftWeight, rightWeight);
    denominator += Math.max(leftWeight, rightWeight);
  });

  return denominator > 0 ? numerator / denominator : 0;
}

function buildRelatedArtists(artistsById: Record<string, CanonicalArtist>) {
  const relatedGraph: Record<string, WeightedEdge[]> = {};
  const artists = Object.values(artistsById);

  artists.forEach((artist) => {
    const neighbors = artists
      .filter((candidate) => candidate.canonicalArtistId !== artist.canonicalArtistId)
      .map((candidate) => ({
        candidate,
        similarity: computeWeightedJaccard(artist.tagWeights, candidate.tagWeights),
      }))
      .filter((entry) => entry.similarity >= 0.25)
      .sort((left, right) => {
        if (left.similarity !== right.similarity) {
          return right.similarity - left.similarity;
        }

        return left.candidate.canonicalArtistId.localeCompare(right.candidate.canonicalArtistId);
      })
      .slice(0, 12)
      .map<WeightedEdge>(({ candidate, similarity }) => ({
        leftId: artist.canonicalArtistId,
        rightId: candidate.canonicalArtistId,
        weight: similarity,
        source: "derived",
        confidence: Math.min(1, similarity + 0.1),
        reason: "shared-tag-similarity",
      }));

    relatedGraph[artist.canonicalArtistId] = neighbors;
    artist.relatedArtistIds = neighbors.map((neighbor) => neighbor.rightId);
  });

  return relatedGraph;
}

export function buildRecommendationCatalogSnapshot(input: {
  tracks: RecommendationSourceTrack[];
  artists: RecommendationSourceArtist[];
  releases: RecommendationSourceRelease[];
  providerMetadata: Record<string, RecommendationSourceProviderMetadata>;
  config: RecommendationConfig;
}) {
  const snapshotRevision = buildSnapshotRevision(input);
  const canonicalizationResult = recommendationTrackCanonicalizationService.buildCanonicalizationResult({
    searchSetId: snapshotRevision,
    tracks: input.tracks,
    canonicalizationRevision: 1,
    config: input.config.canonicalization,
    includeDebugInfo: true,
  });
  const trackById = new Map(input.tracks.map((track) => [track.id, track]));
  const artistLookup = buildArtistLookup(input.artists);
  const releaseLookup = buildReleaseLookup(input.releases);
  const rawTagInputs: Array<{ rawTag: string; evidence: Omit<TagEvidence, "canonicalTagId" | "rawTag"> }> = [];
  const artistsById: Record<string, CanonicalArtist> = {};
  const releasesById: Record<string, CanonicalRelease> = {};
  const tracksById: Record<string, CanonicalTrack> = {};
  const artistToTracks: Record<string, string[]> = {};
  const releaseToTracks: Record<string, string[]> = {};
  const artistToReleases: Record<string, string[]> = {};
  const trackToArtists: Record<string, string[]> = {};
  const playableVariantsByCanonicalTrackId: Record<string, string[]> = {};

  canonicalizationResult.canonicalTracks.forEach((cluster) => {
    const sourceVariants = cluster.variantTrackIds
      .map((trackId) => trackById.get(trackId))
      .filter((track): track is RecommendationSourceTrack => !!track);
    const artistNames = dedupeArtistNames(sourceVariants.flatMap((track) => extractArtistNames(track.artist)));
    const primaryArtistName = artistNames[0] ?? cluster.artist;
    const primarySourceArtist =
      (cluster.musicBrainzArtistId ? artistLookup.byMusicBrainzId.get(cluster.musicBrainzArtistId) : undefined) ??
      artistLookup.byNormalizedName.get(recommendationNormalizationService.normalizeArtistCore(primaryArtistName));
    const canonicalArtistIds = artistNames.map((artistName, index) => {
      const sourceArtist =
        (index === 0 ? primarySourceArtist : undefined) ??
        artistLookup.byNormalizedName.get(recommendationNormalizationService.normalizeArtistCore(artistName));
      const canonicalArtistId = buildArtistId(artistName, sourceArtist?.musicBrainzArtistId ?? null);

      if (!artistsById[canonicalArtistId]) {
        artistsById[canonicalArtistId] = {
          canonicalArtistId,
          musicBrainzArtistId: sourceArtist?.musicBrainzArtistId ?? null,
          name: sourceArtist?.name ?? artistName,
          normalizedName: recommendationNormalizationService.normalizeArtistCore(sourceArtist?.name ?? artistName),
          aliases: sourceArtist?.name && sourceArtist.name !== artistName ? [artistName] : [],
          country: sourceArtist?.country ?? null,
          type: sourceArtist?.type ?? null,
          tagIds: [],
          tagWeights: {},
          relatedArtistIds: [],
          frequentCollaboratorIds: [],
          releaseIds: [],
          trackIds: [],
          sourceEvidence: [],
          quality: {
            confidence: sourceArtist?.musicBrainzArtistId ? 0.9 : 0.6,
            trustScore: sourceArtist?.musicBrainzArtistId ? 0.9 : 0.55,
            metadataCompleteness: sourceArtist?.tags?.length ? 0.7 : 0.35,
          },
          debugInfo: {
            inferredFromArtistText: sourceArtist ? false : true,
            relationHint: inferRelationTypeFromArtistText(cluster.artist),
          },
        };
      }

      artistsById[canonicalArtistId].trackIds = dedupeAndSort([
        ...artistsById[canonicalArtistId].trackIds,
        cluster.canonicalId,
      ]);

      (sourceArtist?.tags ?? []).forEach((tag) => {
        rawTagInputs.push({
          rawTag: tag,
          evidence: {
            subjectType: "artist",
            subjectCanonicalId: canonicalArtistId,
            source: sourceArtist?.musicBrainzArtistId ? "musicbrainz" : "derived",
            sourceTrust: sourceArtist?.musicBrainzArtistId ? 0.75 : 0.45,
            extractionMethod: "artist-source-tags",
            confidence: 0.7,
            weight: 1,
          },
        });
      });

      return canonicalArtistId;
    });

    const canonicalReleaseId =
      cluster.musicBrainzReleaseId || cluster.album
        ? buildReleaseId(cluster.musicBrainzReleaseId ?? cluster.album ?? cluster.canonicalId, cluster.musicBrainzReleaseId)
        : null;
    const sourceRelease =
      (cluster.musicBrainzReleaseId ? releaseLookup.byMusicBrainzId.get(cluster.musicBrainzReleaseId) : undefined) ??
      (cluster.album
        ? input.releases.find(
            (release) =>
              recommendationNormalizationService.normalizeTrackTitle(release.title) ===
              recommendationNormalizationService.normalizeTrackTitle(cluster.album ?? ""),
          )
        : undefined);

    if (canonicalReleaseId) {
      if (!releasesById[canonicalReleaseId]) {
        releasesById[canonicalReleaseId] = {
          canonicalReleaseId,
          musicBrainzReleaseId: sourceRelease?.musicBrainzReleaseId ?? cluster.musicBrainzReleaseId ?? null,
          musicBrainzReleaseGroupId:
            sourceRelease?.musicBrainzReleaseGroupId ?? cluster.musicBrainzReleaseGroupId ?? null,
          title: sourceRelease?.title ?? cluster.album ?? cluster.title,
          canonicalArtistIds: [],
          releaseType: sourceRelease?.kind ?? "other",
          year: parseYear(sourceRelease?.date ?? sourceVariants[0]?.releaseDate),
          labelIds: [],
          coverUrl: sourceRelease?.coverUrl ?? cluster.coverUrl ?? null,
          trackIds: [],
          tagIds: [],
          sourceEvidence: [],
          quality: {
            confidence: sourceRelease?.musicBrainzReleaseId ? 0.85 : 0.55,
            trustScore: sourceRelease?.musicBrainzReleaseId ? 0.9 : 0.5,
            metadataCompleteness: sourceRelease?.date ? 0.65 : 0.35,
          },
        };
      }

      releasesById[canonicalReleaseId].trackIds = dedupeAndSort([
        ...releasesById[canonicalReleaseId].trackIds,
        cluster.canonicalId,
      ]);
      releasesById[canonicalReleaseId].canonicalArtistIds = dedupeAndSort([
        ...releasesById[canonicalReleaseId].canonicalArtistIds,
        ...canonicalArtistIds,
      ]);

      canonicalArtistIds.forEach((artistId) => {
        artistsById[artistId].releaseIds = dedupeAndSort([
          ...artistsById[artistId].releaseIds,
          canonicalReleaseId,
        ]);
      });
    }

    const trackTagWeights: Record<string, number> = {};
    cluster.titleFlavor.forEach((flavor) => {
      rawTagInputs.push({
        rawTag: flavor,
        evidence: {
          subjectType: "track",
          subjectCanonicalId: cluster.canonicalId,
          source: "derived",
          sourceTrust: 0.65,
          extractionMethod: "title-flavor",
          confidence: 0.8,
          weight: flavor === "original" ? 0.2 : 1,
        },
      });
    });

    const popularityPrior = sourceVariants.reduce((best, variant) => {
      const providerPrior = input.providerMetadata[variant.providerId]?.popularityPrior ?? 0;
      return Math.max(best, providerPrior);
    }, 0);
    const playableVariantIds = cluster.variantTrackIds.filter((trackId) => {
      const variant = trackById.get(trackId);
      return !!variant?.audioUrl;
    });

    tracksById[cluster.canonicalId] = {
      canonicalTrackId: cluster.canonicalId,
      musicBrainzRecordingId: cluster.musicBrainzRecordingId ?? null,
      acoustId: cluster.acoustId ?? null,
      title: cluster.title,
      normalizedTitleCore: cluster.normalizedTitleCore ?? recommendationNormalizationService.normalizeTrackTitleCore(cluster.title),
      titleFlavor: cluster.titleFlavor,
      canonicalArtistIds,
      primaryCanonicalArtistId: canonicalArtistIds[0] ?? null,
      featuringCanonicalArtistIds: canonicalArtistIds.slice(1),
      canonicalReleaseId,
      year: parseYear(sourceVariants[0]?.releaseDate),
      labelIds: [],
      language: null,
      explicit: cluster.explicit ?? null,
      targetDurationMs: (cluster.targetDuration ?? 0) * 1000,
      tagIds: [],
      tagWeights: trackTagWeights,
      preferredVariantId: cluster.preferredVariantId ?? null,
      playableVariantIds,
      sourceEvidence: sourceVariants.map((variant) => ({
        canonicalTrackId: cluster.canonicalId,
        provider: variant.providerId,
        rawTrackId: variant.id,
        rawTitle: variant.title,
        rawArtist: variant.artist,
        playable: !!variant.audioUrl,
        duration: variant.duration,
        confidence: variant.musicBrainzRecordingId ? 0.95 : variant.acoustId ? 0.9 : 0.6,
      })),
      quality: {
        clusterConfidence: cluster.quality?.clusterConfidence ?? 0.55,
        trustScore: cluster.quality?.sourceTrustScore ?? 0.5,
        metadataCompleteness: cluster.album || cluster.musicBrainzRecordingId ? 0.8 : 0.45,
        popularityPrior,
      },
      debugInfo: {
        clusterDebugInfo: cluster.debugInfo,
        sourceVariantIds: cluster.variantTrackIds,
      },
    };

    trackToArtists[cluster.canonicalId] = canonicalArtistIds;
    playableVariantsByCanonicalTrackId[cluster.canonicalId] = playableVariantIds.sort(compareLexical);
    canonicalArtistIds.forEach((artistId) => {
      artistToTracks[artistId] = dedupeAndSort([...(artistToTracks[artistId] ?? []), cluster.canonicalId]);
      if (canonicalReleaseId) {
        artistToReleases[artistId] = dedupeAndSort([...(artistToReleases[artistId] ?? []), canonicalReleaseId]);
      }
    });
    if (canonicalReleaseId) {
      releaseToTracks[canonicalReleaseId] = dedupeAndSort([
        ...(releaseToTracks[canonicalReleaseId] ?? []),
        cluster.canonicalId,
      ]);
    }
  });

  const tagsById = buildCanonicalTags(rawTagInputs);

  Object.values(tagsById).forEach((tag) => {
    tag.sourceEvidence.forEach((evidence) => {
      if (evidence.subjectType === "track" && tracksById[evidence.subjectCanonicalId]) {
        tracksById[evidence.subjectCanonicalId].tagIds = dedupeAndSort([
          ...tracksById[evidence.subjectCanonicalId].tagIds,
          tag.canonicalTagId,
        ]);
        tracksById[evidence.subjectCanonicalId].tagWeights[tag.canonicalTagId] = Math.max(
          tracksById[evidence.subjectCanonicalId].tagWeights[tag.canonicalTagId] ?? 0,
          evidence.weight,
        );
      }

      if (evidence.subjectType === "artist" && artistsById[evidence.subjectCanonicalId]) {
        artistsById[evidence.subjectCanonicalId].tagIds = dedupeAndSort([
          ...artistsById[evidence.subjectCanonicalId].tagIds,
          tag.canonicalTagId,
        ]);
        artistsById[evidence.subjectCanonicalId].tagWeights[tag.canonicalTagId] = Math.max(
          artistsById[evidence.subjectCanonicalId].tagWeights[tag.canonicalTagId] ?? 0,
          evidence.weight,
        );
      }
    });
  });

  Object.values(releasesById).forEach((release) => {
    release.tagIds = dedupeAndSort(
      release.canonicalArtistIds.flatMap((artistId) => artistsById[artistId]?.tagIds ?? []),
    );
  });

  const relatedArtists = buildRelatedArtists(artistsById);
  const collaborationEvidence = extractArtistRelations({
    artistsById,
    tracksById,
  });
  const artistRelations = buildArtistRelationGraph(collaborationEvidence);

  Object.values(artistsById).forEach((artist) => {
    artist.frequentCollaboratorIds = (artistRelations[artist.canonicalArtistId] ?? [])
      .filter((edge) => edge.weight >= 0.4)
      .map((edge) => edge.rightId);
  });

  const tagToTracks: Record<string, string[]> = {};
  const tagToArtists: Record<string, string[]> = {};
  Object.values(tracksById).forEach((track) => {
    track.tagIds.forEach((tagId) => {
      tagToTracks[tagId] = dedupeAndSort([...(tagToTracks[tagId] ?? []), track.canonicalTrackId]);
    });
  });
  Object.values(artistsById).forEach((artist) => {
    artist.tagIds.forEach((tagId) => {
      tagToArtists[tagId] = dedupeAndSort([...(tagToArtists[tagId] ?? []), artist.canonicalArtistId]);
    });
  });

  const releaseAdjacency: Record<string, string[]> = {};
  Object.values(releasesById).forEach((release) => {
    const neighbors = Object.values(releasesById)
      .filter((candidate) => candidate.canonicalReleaseId !== release.canonicalReleaseId)
      .filter(
        (candidate) =>
          candidate.canonicalArtistIds.some((artistId) => release.canonicalArtistIds.includes(artistId)) ||
          (release.year !== null &&
            candidate.year !== null &&
            release.year !== undefined &&
            candidate.year !== undefined &&
            Math.abs((release.year ?? 0) - (candidate.year ?? 0)) <= 2),
      )
      .map((candidate) => candidate.canonicalReleaseId)
      .sort(compareLexical);

    releaseAdjacency[release.canonicalReleaseId] = neighbors;
  });

  return {
    snapshotRevision,
    generatedAt: new Date().toISOString(),
    canonicalizationVersion: canonicalizationResult.canonicalizationVersion,
    canonicalizationRevision: canonicalizationResult.canonicalizationRevision,
    tracksById,
    artistsById,
    releasesById,
    tagsById,
    canonicalIdByVariantTrackId: canonicalizationResult.canonicalIdByVariantTrackId,
    artistToTracks,
    releaseToTracks,
    trackToArtists,
    artistToReleases,
    artistRelations,
    relatedArtists,
    tagToTracks,
    tagToArtists,
    releaseAdjacency,
    playableVariantsByCanonicalTrackId,
  } satisfies RecommendationCatalogSnapshot;
}

function dedupeAndSort(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort(compareLexical);
}

function dedupeArtistNames(values: string[]) {
  return dedupeAndSort(values.map((value) => value.trim()));
}
