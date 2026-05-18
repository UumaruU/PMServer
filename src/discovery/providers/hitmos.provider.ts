import type { DiscoveryProvider, ExternalTrack } from "./provider.types";
import { decodeHtmlEntities, fetchText, parseDurationToMs, readAttr, toAbsoluteUrl } from "./providerUtils";

const HITMOS_BASE_URL = "https://rus.hitmotop.com";

type HitmosMeta = {
  artist?: string;
  title?: string;
  url?: string;
  img?: string;
  id?: string;
};

function parseTracksFromHtml(html: string, limit: number): ExternalTrack[] {
  const blocks = html.match(/<li\b[^>]*class=["'][^"']*\btracks__item\b[^"']*\btrack\b[^"']*["'][\s\S]*?<\/li>/gi) ?? [];
  const tracks: ExternalTrack[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (tracks.length >= limit) {
      break;
    }

    const rawMeta = readAttr(block, "data-musmeta");
    if (!rawMeta) {
      continue;
    }

    let meta: HitmosMeta | null = null;
    try {
      meta = JSON.parse(decodeHtmlEntities(rawMeta)) as HitmosMeta;
    } catch {
      continue;
    }

    const sourceTrackId = meta.id?.trim().replace(/^track-id-/, "");
    const title = meta.title?.trim();
    const artistName = meta.artist?.trim();
    if (!sourceTrackId || !title || !artistName || seen.has(sourceTrackId)) {
      continue;
    }

    seen.add(sourceTrackId);
    const downloadHref = block.match(/<a\b[^>]*class=["'][^"']*\btrack__download-btn\b[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1];
    const durationText = block.match(/class=["'][^"']*\btrack__fulltime\b[^"']*["'][^>]*>([\s\S]*?)</i)?.[1];
    tracks.push({
      providerId: "hitmos",
      sourceTrackId,
      title,
      artistName,
      coverUrl: toAbsoluteUrl(HITMOS_BASE_URL, meta.img),
      audioUrl: toAbsoluteUrl(HITMOS_BASE_URL, downloadHref ?? meta.url),
      durationMs: parseDurationToMs(durationText),
      sourceUrl:
        toAbsoluteUrl(
          HITMOS_BASE_URL,
          block.match(/<a\b[^>]*class=["'][^"']*\btrack__info-l\b[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1],
        ) ?? `${HITMOS_BASE_URL}/search?q=${encodeURIComponent(`${artistName} ${title}`)}`,
    });
  }

  return tracks;
}

export function createHitmosProvider(): DiscoveryProvider {
  return {
    providerId: "hitmos",

    async searchTracks(query, limit = 5) {
      const normalizedQuery = query.trim();
      const url = normalizedQuery
        ? `${HITMOS_BASE_URL}/search?q=${encodeURIComponent(normalizedQuery)}`
        : HITMOS_BASE_URL;
      const html = await fetchText(url, {
        Referer: HITMOS_BASE_URL,
      });

      return html ? parseTracksFromHtml(html, limit) : [];
    },
  };
}
