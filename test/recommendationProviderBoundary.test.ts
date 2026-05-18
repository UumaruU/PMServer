import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const recommendationFiles = [
  "src/recommendation/candidate-generation/generateCandidates.ts",
  "src/recommendation/scoring/scoreCandidates.ts",
  "src/recommendation/next-track/getNextRecommendedTrack.ts",
];

describe("recommendation provider boundary", () => {
  it("keeps candidate generators and rankers provider-free", () => {
    for (const file of recommendationFiles) {
      const text = readFileSync(join(process.cwd(), file), "utf8");

      expect(text).not.toContain("../discovery/providers");
      expect(text).not.toContain("getSimilarArtists");
      expect(text).not.toContain("getArtistTopTracks");
      expect(text).not.toContain("searchTracks");
    }
  });
});
