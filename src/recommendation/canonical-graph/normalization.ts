import { RecommendationSourceTrack, TitleFlavor } from "../types";

const titleFlavorPatterns: Array<{ flavor: TitleFlavor; pattern: RegExp }> = [
  { flavor: "live", pattern: /\blive\b/gi },
  { flavor: "live", pattern: /\bлайв\b/gi },
  { flavor: "acoustic", pattern: /\bacoustic\b/gi },
  { flavor: "acoustic", pattern: /\bакуст(?:ика|ик|ический|ическая)?\b/gi },
  { flavor: "instrumental", pattern: /\binstrumental\b/gi },
  { flavor: "instrumental", pattern: /\bминус\b/gi },
  { flavor: "karaoke", pattern: /\bkaraoke\b/gi },
  { flavor: "karaoke", pattern: /\bкараоке\b/gi },
  { flavor: "remix", pattern: /\bremix\b/gi },
  { flavor: "remix", pattern: /\bремикс\b/gi },
  { flavor: "edit", pattern: /\bedit\b/gi },
  { flavor: "radio_edit", pattern: /\bradio\s+edit\b/gi },
  { flavor: "extended", pattern: /\bextended\b/gi },
  { flavor: "demo", pattern: /\bdemo\b/gi },
  { flavor: "cover", pattern: /\bcover\b/gi },
  { flavor: "cover", pattern: /\bкавер\b/gi },
];

const genericNoisePatterns = [
  /\((?:feat|ft|featuring)\.?.*?\)/gi,
  /\[(?:feat|ft|featuring)\.?.*?\]/gi,
  /\b(?:feat|ft|featuring)\.?\s+.+$/gi,
  /\bofficial\s+(?:audio|video|lyric\s+video)\b/gi,
  /\baudio\b/gi,
  /\blyric\s+video\b/gi,
  /\bnightcore\b/gi,
  /\bbass\s+boosted\b/gi,
  /\breverb\b/gi,
  /\bslowed\b/gi,
  /\bsped\s+up\b/gi,
  /\bversion\b/gi,
];

const artistTitleSeparatorPattern = /^\s*(.+?)\s+[\-\u2013\u2014]\s+(.+?)\s*$/;
const embeddedArtistNoisePattern =
  /\b(?:official|audio|video|lyrics?|lyric|feat|ft|featuring|prod|remix|mix|version)\b/i;
const spacedSingleCharacterPattern = /^(?:[\p{L}0-9]\s+){2,}[\p{L}0-9]$/iu;

const visualConfusableMap: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  к: "k",
  м: "m",
  т: "t",
  в: "b",
  н: "h",
  і: "i",
  ј: "j",
  ё: "e",
};

const transliterationMap: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanupDelimiters(value: string) {
  return value
    .replace(/[_]+/g, " ")
    .replace(/\s*[\-\u2013\u2014]\s*/g, " - ")
    .replace(/[(){}\[\]]/g, " ");
}

function normalizeBaseText(value: string) {
  return normalizeWhitespace(cleanupDelimiters(value).normalize("NFKC").toLowerCase());
}

function stripNoise(value: string) {
  return genericNoisePatterns.reduce((result, pattern) => result.replace(pattern, " "), value);
}

function dedupeSorted<T extends string>(values: T[]) {
  return [...new Set(values)].sort();
}

function transliterateCyrillic(value: string) {
  return [...value].map((char) => transliterationMap[char] ?? char).join("");
}

function foldVisualConfusables(value: string) {
  return [...value].map((char) => visualConfusableMap[char] ?? char).join("");
}

function normalizeComparisonToken(token: string) {
  if (!token) {
    return "";
  }

  if (/^[mм][cс]$/iu.test(token)) {
    return "mc";
  }

  if (/^[а-яё0-9]+$/iu.test(token)) {
    return transliterateCyrillic(token);
  }

  return foldVisualConfusables(token);
}

function tokenizeNormalized(value: string) {
  return value
    .split(/[^\p{L}0-9]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function stemLooseToken(token: string) {
  if (token.length >= 7) {
    const longSuffixes = [
      "иями",
      "ями",
      "ами",
      "ого",
      "ему",
      "ыми",
      "ими",
      "ая",
      "яя",
      "ое",
      "ее",
      "ий",
      "ый",
      "ой",
      "ую",
      "юю",
      "на",
    ];
    const matchingSuffix = longSuffixes.find((suffix) => token.endsWith(suffix));

    if (matchingSuffix) {
      return token.slice(0, -matchingSuffix.length);
    }
  }

  if (token.length >= 8 && /[аяеыиоюу]$/iu.test(token)) {
    return token.slice(0, -1);
  }

  return token;
}

function buildLooseSignature(value: string) {
  return tokenizeNormalized(normalizeComparisonText(value))
    .map((token) => stemLooseToken(token).slice(0, 8))
    .join(" ");
}

function detectFlavors(title: string) {
  const matches = titleFlavorPatterns
    .filter(({ pattern }) => {
      pattern.lastIndex = 0;
      return pattern.test(title);
    })
    .map(({ flavor }) => flavor);

  return matches.length ? dedupeSorted(matches) : (["original"] satisfies TitleFlavor[]);
}

function stripFlavors(value: string) {
  return titleFlavorPatterns.reduce((result, { pattern }) => result.replace(pattern, " "), value);
}

function removeArtistNoise(value: string) {
  return value
    .replace(/\b(?:feat|ft|featuring)\.?\b/gi, ",")
    .replace(/[|/]/g, ",")
    .replace(/\s+x\s+/gi, ",");
}

function countDisplayTokens(value: string) {
  return normalizeWhitespace(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean).length;
}

function getArtistDisplayQuality(value: string) {
  const trimmed = normalizeWhitespace(value);

  if (!trimmed) {
    return Number.NEGATIVE_INFINITY;
  }

  const comparison = normalizeComparisonText(trimmed);
  const tokenCount = countDisplayTokens(trimmed);
  let score = 0;

  if (comparison) {
    score += 2;
  }

  if (comparison.length >= 4) {
    score += 1;
  }

  if (tokenCount >= 1 && tokenCount <= 4) {
    score += 2;
  } else if (tokenCount > 5) {
    score -= 2;
  }

  if (spacedSingleCharacterPattern.test(trimmed)) {
    score -= 4;
  }

  if (embeddedArtistNoisePattern.test(trimmed)) {
    score -= 4;
  }

  if (/^\d+$/.test(comparison)) {
    score -= 2;
  }

  return score;
}

function looksLikeEmbeddedArtist(value: string) {
  const trimmed = normalizeWhitespace(value);
  const tokenCount = countDisplayTokens(trimmed);

  if (!trimmed || tokenCount === 0 || tokenCount > 4) {
    return false;
  }

  if (embeddedArtistNoisePattern.test(trimmed)) {
    return false;
  }

  return normalizeComparisonText(trimmed).length >= 2;
}

function chooseArtistDisplay(currentArtist: string, embeddedArtist: string) {
  const currentQuality = getArtistDisplayQuality(currentArtist);
  const embeddedQuality = getArtistDisplayQuality(embeddedArtist);

  if (embeddedQuality !== currentQuality) {
    return embeddedQuality > currentQuality ? normalizeWhitespace(embeddedArtist) : normalizeWhitespace(currentArtist);
  }

  if (embeddedArtist.length !== currentArtist.length) {
    return embeddedArtist.length > currentArtist.length
      ? normalizeWhitespace(embeddedArtist)
      : normalizeWhitespace(currentArtist);
  }

  return [normalizeWhitespace(currentArtist), normalizeWhitespace(embeddedArtist)].sort()[0];
}

export function extractPrimaryArtistName(rawArtist: string) {
  const cleaned = removeArtistNoise(rawArtist);

  return (
    cleaned
      .split(/,|&|;| and /i)
      .map((part) => normalizeWhitespace(part))
      .find(Boolean) || normalizeWhitespace(rawArtist)
  );
}

function normalizeArtistCore(value: string) {
  return normalizeComparisonText(removeArtistNoise(extractPrimaryArtistName(value)));
}

function normalizeArtistDisplay(value: string) {
  return normalizeBaseText(removeArtistNoise(value));
}

function normalizeTitleCore(title: string) {
  return normalizeComparisonText(stripFlavors(stripNoise(title)));
}

export function normalizeComparisonText(value: string) {
  return normalizeWhitespace(
    normalizeBaseText(value)
      .split(/[^\p{L}0-9]+/u)
      .map((token) => normalizeComparisonToken(token))
      .filter(Boolean)
      .join(" "),
  );
}

export function normalizeTrackPresentation(title: string, artist: string) {
  const normalizedTitle = normalizeWhitespace(title);
  const normalizedArtist = normalizeWhitespace(artist);
  const embeddedMatch = normalizedTitle.match(artistTitleSeparatorPattern);

  if (!embeddedMatch) {
    return {
      title: normalizedTitle,
      artist: normalizedArtist,
    };
  }

  const embeddedArtist = normalizeWhitespace(embeddedMatch[1]);
  const embeddedTitle = normalizeWhitespace(embeddedMatch[2]);

  if (!embeddedTitle || !looksLikeEmbeddedArtist(embeddedArtist)) {
    return {
      title: normalizedTitle,
      artist: normalizedArtist,
    };
  }

  const currentArtistCore = normalizeArtistCore(normalizedArtist);
  const embeddedArtistCore = normalizeArtistCore(embeddedArtist);

  if (!embeddedArtistCore) {
    return {
      title: normalizedTitle,
      artist: normalizedArtist,
    };
  }

  if (currentArtistCore && currentArtistCore === embeddedArtistCore) {
    return {
      title: embeddedTitle,
      artist: chooseArtistDisplay(normalizedArtist, embeddedArtist),
    };
  }

  const embeddedArtistQuality = getArtistDisplayQuality(embeddedArtist);
  const currentArtistQuality = getArtistDisplayQuality(normalizedArtist);

  if (!currentArtistCore || embeddedArtistQuality >= currentArtistQuality + 2) {
    return {
      title: embeddedTitle,
      artist: normalizeWhitespace(embeddedArtist),
    };
  }

  return {
    title: normalizedTitle,
    artist: normalizedArtist,
  };
}

export function getDurationBucket(durationSeconds: number, sizeSeconds = 2) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }

  return Math.round(durationSeconds / sizeSeconds);
}

export function normalizeTrackForCanonicalization(track: RecommendationSourceTrack) {
  const titleFlavor = detectFlavors(track.title);

  return {
    normalizedTitle: normalizeBaseText(stripNoise(track.title)),
    normalizedArtistName: normalizeArtistDisplay(track.artist),
    normalizedTitleCore: normalizeTitleCore(track.title),
    normalizedArtistCore: normalizeArtistCore(track.artist),
    primaryArtist: normalizeArtistCore(extractPrimaryArtistName(track.artist)),
    titleFlavor,
    durationBucket: getDurationBucket(track.duration),
    normalizedTitleSignature: buildLooseSignature(track.title),
    normalizedArtistSignature: buildLooseSignature(track.artist),
  };
}

export const recommendationNormalizationService = {
  normalizeArtistName(artist: string) {
    return normalizeArtistDisplay(artist);
  },

  normalizeArtistCore(artist: string) {
    return normalizeArtistCore(artist);
  },

  normalizeTrackTitle(title: string) {
    return normalizeBaseText(stripNoise(title));
  },

  normalizeTrackTitleCore(title: string) {
    return normalizeTitleCore(title);
  },

  normalizeComparisonText,

  buildLooseSignature(value: string) {
    return buildLooseSignature(value);
  },

  extractTitleFlavor(title: string) {
    return detectFlavors(title);
  },

  extractPrimaryArtistName,

  normalizeTrackPresentation,

  normalizeTrackForCanonicalization,

  getDurationBucket,
};
