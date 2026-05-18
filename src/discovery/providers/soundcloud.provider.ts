import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DiscoveryProvider, ExternalTrack } from "./provider.types";

const execFileAsync = promisify(execFile);

type YtDlpEntry = {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  webpage_url?: string;
  url?: string;
};

async function hasYtDlp() {
  try {
    await execFileAsync("yt-dlp", ["--version"], {
      timeout: 3000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function splitSoundCloudTitle(entry: YtDlpEntry) {
  const title = entry.title?.trim();
  if (!title) {
    return null;
  }

  const parts = title.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return {
      artistName: parts[0]!.trim(),
      title: parts.slice(1).join(" - ").trim(),
    };
  }

  return {
    artistName: entry.uploader?.trim() || entry.channel?.trim() || "SoundCloud",
    title,
  };
}

export function createSoundcloudProvider(enabled = false): DiscoveryProvider | null {
  if (!enabled) {
    return null;
  }

  return {
    providerId: "soundcloud",

    async searchTracks(query, limit = 5) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery || !(await hasYtDlp())) {
        return [];
      }

      try {
        const { stdout } = await execFileAsync(
          "yt-dlp",
          ["--dump-json", "--skip-download", `scsearch${Math.max(1, Math.min(limit, 10))}:${normalizedQuery}`],
          {
            timeout: 12000,
            maxBuffer: 1024 * 1024 * 4,
            windowsHide: true,
          },
        );

        return stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map<ExternalTrack | null>((line) => {
            let entry: YtDlpEntry;
            try {
              entry = JSON.parse(line) as YtDlpEntry;
            } catch {
              return null;
            }

            const parsed = splitSoundCloudTitle(entry);
            if (!entry.id || !parsed?.title || !parsed.artistName) {
              return null;
            }

            return {
              providerId: "soundcloud",
              sourceTrackId: entry.id,
              title: parsed.title,
              artistName: parsed.artistName,
              durationMs: typeof entry.duration === "number" ? Math.round(entry.duration * 1000) : null,
              coverUrl: entry.thumbnail ?? null,
              audioUrl: entry.url ?? null,
              sourceUrl: entry.webpage_url ?? null,
            };
          })
          .filter((track): track is ExternalTrack => !!track)
          .slice(0, limit);
      } catch {
        return [];
      }
    },
  };
}
