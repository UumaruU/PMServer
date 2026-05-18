export function normalizeOptional(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function stripHtml(value: string) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")).split(/\s+/).filter(Boolean).join(" ");
}

export function toAbsoluteUrl(baseUrl: string, value?: string | null) {
  const normalized = normalizeOptional(value);
  if (!normalized) {
    return null;
  }

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  if (normalized.startsWith("//")) {
    return `https:${normalized}`;
  }

  if (normalized.startsWith("/")) {
    return `${baseUrl}${normalized}`;
  }

  return `${baseUrl}/${normalized}`;
}

export async function fetchText(url: string, headers: Record<string, string> = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "PinguMusic/1.0 (+https://example.invalid)",
        ...headers,
      },
    });

    if (!response.ok) {
      return null;
    }

    return response.text();
  } catch {
    return null;
  }
}

export async function fetchJson<T>(url: string, headers: Record<string, string> = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "PinguMusic/1.0 (+https://example.invalid)",
        Accept: "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function parseDurationToMs(value?: string | null) {
  const normalized = normalizeOptional(value);
  if (!normalized) {
    return null;
  }

  const parts = normalized.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  const seconds =
    parts.length === 3
      ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
      : parts.length === 2
        ? parts[0]! * 60 + parts[1]!
        : parts[0]!;

  return Math.max(0, Math.round(seconds * 1000));
}

export function readAttr(block: string, name: string) {
  const match = block.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
  return match ? decodeHtmlEntities(match[1]!) : null;
}
