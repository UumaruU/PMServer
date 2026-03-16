import { CanonicalTag, RecommendationTagType, TagEvidence } from "../types";

const JUNK_TAGS = new Set([
  "favorites",
  "seen live",
  "awesome",
  "best",
  "my playlist",
  "random",
]);

const TAG_ALIASES: Record<string, { slug: string; displayName: string; tagType: RecommendationTagType }> = {
  "hip hop": { slug: "hip-hop", displayName: "Hip-Hop", tagType: "genre" },
  hiphop: { slug: "hip-hop", displayName: "Hip-Hop", tagType: "genre" },
  "alt hip hop": {
    slug: "alternative-hip-hop",
    displayName: "Alternative Hip-Hop",
    tagType: "subgenre",
  },
  "indie rock": { slug: "indie-rock", displayName: "Indie Rock", tagType: "subgenre" },
  rap: { slug: "rap", displayName: "Rap", tagType: "genre" },
  rock: { slug: "rock", displayName: "Rock", tagType: "genre" },
  pop: { slug: "pop", displayName: "Pop", tagType: "genre" },
  electronic: { slug: "electronic", displayName: "Electronic", tagType: "genre" },
  live: { slug: "live", displayName: "Live", tagType: "audio_trait" },
  acoustic: { slug: "acoustic", displayName: "Acoustic", tagType: "audio_trait" },
  remix: { slug: "remix", displayName: "Remix", tagType: "audio_trait" },
  instrumental: { slug: "instrumental", displayName: "Instrumental", tagType: "audio_trait" },
  sad: { slug: "sad", displayName: "Sad", tagType: "mood" },
  happy: { slug: "happy", displayName: "Happy", tagType: "mood" },
  chill: { slug: "chill", displayName: "Chill", tagType: "mood" },
};

function normalizeTagText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[_/]+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ");
}

function toTitleCase(value: string) {
  return value
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("-");
}

export function normalizeTag(rawTag: string) {
  const normalized = normalizeTagText(rawTag);

  if (!normalized || JUNK_TAGS.has(normalized)) {
    return null;
  }

  const alias = TAG_ALIASES[normalized];
  if (alias) {
    return alias;
  }

  return {
    slug: normalized.replace(/\s+/g, "-"),
    displayName: toTitleCase(normalized.replace(/\s+/g, "-")),
    tagType: "genre" as RecommendationTagType,
  };
}

export function buildCanonicalTags(
  rawTags: Array<{
    rawTag: string;
    evidence: Omit<TagEvidence, "canonicalTagId" | "rawTag">;
  }>,
) {
  const tagsById = new Map<string, CanonicalTag>();

  rawTags.forEach(({ rawTag, evidence }) => {
    const normalized = normalizeTag(rawTag);
    if (!normalized) {
      return;
    }

    const canonicalTagId = `tag:${normalized.slug}`;
    const existing = tagsById.get(canonicalTagId);
    const nextEvidence: TagEvidence = {
      ...evidence,
      rawTag,
      canonicalTagId,
    };

    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, rawTag.trim().toLowerCase()])].sort();
      existing.sourceEvidence.push(nextEvidence);
      existing.quality.confidence = Math.max(existing.quality.confidence, nextEvidence.confidence);
      existing.quality.trustScore = Math.max(existing.quality.trustScore, nextEvidence.sourceTrust);
      return;
    }

    tagsById.set(canonicalTagId, {
      canonicalTagId,
      slug: normalized.slug,
      displayName: normalized.displayName,
      aliases: [rawTag.trim().toLowerCase()],
      tagType: normalized.tagType,
      parentTagId: null,
      normalizedForm: normalized.slug,
      sourceEvidence: [nextEvidence],
      quality: {
        confidence: nextEvidence.confidence,
        trustScore: nextEvidence.sourceTrust,
      },
    });
  });

  return Object.fromEntries([...tagsById.entries()].sort(([left], [right]) => left.localeCompare(right)));
}
