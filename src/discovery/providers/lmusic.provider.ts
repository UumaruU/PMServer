import type { DiscoveryProvider, ExternalArtist, ExternalTrack } from "./provider.types";
import { fetchText, parseDurationToMs, readAttr, stripHtml, toAbsoluteUrl } from "./providerUtils";

const LMUSIC_BASE_URL = "https://lmusic.kz";

function parseTracksFromHtml(html: string, limit: number): ExternalTrack[] {
  const blocks = html.match(/<div\b[^>]*class=["'][^"']*\bc-card-mp3\b[^"']*\bjs-item-mp3\b[^"']*["'][\s\S]*?<\/div>\s*<\/div>/gi) ?? [];
  const tracks: ExternalTrack[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (tracks.length >= limit) {
      break;
    }

    const sourceTrackId = readAttr(block, "data-mp3_id");
    const title = readAttr(block, "data-song_name");
    const artistName = readAttr(block, "data-artist_name");
    if (!sourceTrackId || !title || !artistName || seen.has(sourceTrackId)) {
      continue;
    }

    seen.add(sourceTrackId);
    const coverUrl =
      toAbsoluteUrl(LMUSIC_BASE_URL, readAttr(block, "data-cover_url")) ??
      toAbsoluteUrl(LMUSIC_BASE_URL, block.match(/<img\b[^>]*(?:data-src|src)=["']([^"']+)["']/i)?.[1]);
    const durationText = block.match(/class=["'][^"']*\bc-card-mp3__duration\b[^"']*["'][^>]*>([\s\S]*?)</i)?.[1];

    tracks.push({
      providerId: "lmusic",
      sourceTrackId,
      title,
      artistName,
      coverUrl,
      audioUrl: toAbsoluteUrl(LMUSIC_BASE_URL, readAttr(block, "data-src_url")),
      durationMs: parseDurationToMs(durationText),
      sourceUrl:
        toAbsoluteUrl(LMUSIC_BASE_URL, readAttr(block, "data-url")) ??
        `${LMUSIC_BASE_URL}/search?q=${encodeURIComponent(`${artistName} ${title}`)}`,
    });
  }

  return tracks;
}

function parseArtistMetadata(html: string, fallbackName: string): ExternalArtist | null {
  const name =
    stripHtml(html.match(/<h1\b[^>]*class=["'][^"']*\bc-artist-header__artist-name\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") ||
    fallbackName;
  if (!name.trim()) {
    return null;
  }

  const tags = [
    ...new Set(
      [...html.matchAll(/class=["'][^"']*\bc-hashtag\b[^"']*["'][^>]*>([\s\S]*?)</gi)]
        .map((match) => stripHtml(match[1] ?? ""))
        .filter(Boolean),
    ),
  ];
  const imageUrl = toAbsoluteUrl(
    LMUSIC_BASE_URL,
    html.match(/<img\b[^>]*class=["'][^"']*\bc-artist-header__img\b[^"']*["'][^>]*(?:data-src|src)=["']([^"']+)["']/i)?.[1],
  );

  return {
    providerId: "lmusic",
    sourceArtistId: name,
    name,
    imageUrl,
    tags,
  };
}

export function createLmusicProvider(): DiscoveryProvider {
  return {
    providerId: "lmusic",

    async searchTracks(query, limit = 5) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return [];
      }

      const html = await fetchText(`${LMUSIC_BASE_URL}/search?q=${encodeURIComponent(normalizedQuery)}`);
      return html ? parseTracksFromHtml(html, limit) : [];
    },

    async getArtist(input) {
      const name = input.name?.trim();
      if (!name) {
        return null;
      }

      const searchHtml = await fetchText(`${LMUSIC_BASE_URL}/search?q=${encodeURIComponent(name)}`);
      const slug = searchHtml?.match(/href=["']\/artist\/([^"']+)["'][^>]*>[^<]*<\/a>/i)?.[1];
      if (!slug) {
        return null;
      }

      const artistHtml = await fetchText(`${LMUSIC_BASE_URL}/artist/${slug}`);
      return artistHtml ? parseArtistMetadata(artistHtml, name) : null;
    },
  };
}
