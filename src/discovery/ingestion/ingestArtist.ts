import type { Prisma, PrismaClient } from "@prisma/client";

import { recommendationNormalizationService } from "../../recommendation/canonical-graph/normalization";
import type { ExternalArtist } from "../providers/provider.types";

type DbClient = PrismaClient | Prisma.TransactionClient;

function createDeterministicHash(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0).toString(16);
}

function normalizeOptional(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function buildArtistId(input: { name: string; musicBrainzArtistId?: string | null }) {
  if (input.musicBrainzArtistId) {
    return `artist:${input.musicBrainzArtistId}`;
  }

  return `artist:soft:${createDeterministicHash(recommendationNormalizationService.normalizeArtistCore(input.name))}`;
}

export async function ingestArtist(prisma: DbClient, input: ExternalArtist) {
  const name = input.name.trim();
  const musicBrainzArtistId = normalizeOptional(input.musicBrainzArtistId);
  const artistId = buildArtistId({ name, musicBrainzArtistId });
  const normalizedName = recommendationNormalizationService.normalizeArtistCore(name);
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  const now = new Date();
  const metadataFreshness = musicBrainzArtistId ? 0.9 : 0.62;

  const artist = await prisma.artist.upsert({
    where: {
      id: artistId,
    },
    create: {
      id: artistId,
      name,
      normalizedName,
      musicBrainzArtistId,
      type: normalizeOptional(input.type),
      country: normalizeOptional(input.country),
      area: normalizeOptional(input.area),
      imageUrl: normalizeOptional(input.imageUrl),
      tags,
      qualityScore: musicBrainzArtistId ? 0.9 : 0.62,
      lastIndexedAt: now,
      lastProviderCheckAt: now,
      lastSeenAt: now,
      metadataFreshness,
    },
    update: {
      name,
      normalizedName,
      musicBrainzArtistId,
      type: normalizeOptional(input.type),
      country: normalizeOptional(input.country),
      area: normalizeOptional(input.area),
      imageUrl: normalizeOptional(input.imageUrl),
      tags,
      qualityScore: musicBrainzArtistId ? 0.9 : 0.62,
      lastIndexedAt: now,
      lastProviderCheckAt: now,
      lastSeenAt: now,
      metadataFreshness,
    },
  });

  const sourceArtistId = normalizeOptional(input.sourceArtistId) ?? musicBrainzArtistId ?? normalizedName;
  await prisma.artistSource.upsert({
    where: {
      providerId_sourceArtistId: {
        providerId: input.providerId,
        sourceArtistId,
      },
    },
    create: {
      artistId: artist.id,
      providerId: input.providerId,
      sourceArtistId,
      name,
      musicBrainzArtistId,
      tags,
      url: null,
      trustScore: musicBrainzArtistId ? 0.85 : 0.55,
      lastIndexedAt: now,
      lastProviderCheckAt: now,
      lastSeenAt: now,
      metadataFreshness,
    },
    update: {
      artistId: artist.id,
      name,
      musicBrainzArtistId,
      tags,
      trustScore: musicBrainzArtistId ? 0.85 : 0.55,
      lastIndexedAt: now,
      lastProviderCheckAt: now,
      lastSeenAt: now,
      metadataFreshness,
    },
  });

  return artist;
}
