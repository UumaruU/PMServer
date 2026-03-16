import {
  updateProfilesFromDislike,
  updateProfilesFromFavorite,
  updateProfilesFromPlayback,
  updateProfilesFromPlaylist,
  loadProfiles,
  saveProfiles,
} from "./affinity/profileStore";
import { defaultRecommendationConfig } from "./config/defaultRecommendationConfig";
import { getBestNextTrack, getRankedArtistRecommendations, getRankedTrackRecommendations } from "./next-track/getNextRecommendedTrack";
import {
  RecommendationConfig,
  RecommendationContext,
  RecommendationEngine,
  RecommendationEngineDependencies,
  RecommendationProfiles,
  RecommendationSeed,
} from "./types";

async function enrichContext(
  deps: RecommendationEngineDependencies,
  context: RecommendationContext,
  profiles: RecommendationProfiles,
) {
  const history = await deps.userHistoryReader.getRecentHistory();
  const favorites = await deps.favoritesReader.getFavoriteTrackIds();

  return {
    ...context,
    favoritedTrackIds: context.favoritedTrackIds.length ? context.favoritedTrackIds : favorites,
    recentTrackIds:
      context.recentTrackIds.length
        ? context.recentTrackIds
        : history.map((entry) => entry.trackId).filter(Boolean).slice(0, 24),
    skippedTrackIds: context.skippedTrackIds.length
      ? context.skippedTrackIds
      : profiles.session.recentSkippedTrackIds,
    recentRecommendationIds: context.recentRecommendationIds.length
      ? context.recentRecommendationIds
      : profiles.session.recentRecommendationIds,
    longTermTasteProfile: context.longTermTasteProfile ?? profiles.longTerm,
    sessionTasteProfile: context.sessionTasteProfile ?? profiles.session,
  } satisfies RecommendationContext;
}

// Future backend extraction point: only adapters in deps need replacement for server-side execution.
export function createRecommendationEngine(
  deps: RecommendationEngineDependencies,
  config: RecommendationConfig = defaultRecommendationConfig,
): RecommendationEngine {
  return {
    async getNextRecommendedTrack(context) {
      const snapshot = await deps.catalogReader.getSnapshot();
      const profiles = await loadProfiles(deps.cacheStore);
      const enrichedContext = await enrichContext(deps, context, profiles);
      const result = getBestNextTrack({
        seed: {
          mode: context.mode,
          canonicalTrackId: enrichedContext.currentCanonicalTrackId ?? undefined,
        },
        context: enrichedContext,
        snapshot,
        profiles,
        config,
      });

      await deps.resultWriter.writeTrackResult({
        context: enrichedContext,
        result,
      });
      if (result) {
        profiles.session.recentRecommendationIds = [
          result.canonicalTrackId,
          ...profiles.session.recentRecommendationIds.filter((id) => id !== result.canonicalTrackId),
        ].slice(0, 32);
        await saveProfiles(deps.cacheStore, profiles);
      }
      return result;
    },

    async getRecommendedTracks(seed: RecommendationSeed, context: RecommendationContext) {
      const snapshot = await deps.catalogReader.getSnapshot();
      const profiles = await loadProfiles(deps.cacheStore);
      const enrichedContext = await enrichContext(deps, context, profiles);
      const results = getRankedTrackRecommendations({
        seed,
        context: enrichedContext,
        snapshot,
        profiles,
        config,
      });

      await deps.resultWriter.writeTrackRanking({
        seed,
        context: enrichedContext,
        results,
      });
      profiles.session.recentRecommendationIds = [
        ...results.map((result) => result.canonicalTrackId),
        ...profiles.session.recentRecommendationIds,
      ]
        .filter((value, index, list) => list.indexOf(value) === index)
        .slice(0, 32);
      await saveProfiles(deps.cacheStore, profiles);
      return results;
    },

    async getRecommendedArtists(seed: RecommendationSeed, context: RecommendationContext) {
      const snapshot = await deps.catalogReader.getSnapshot();
      const profiles = await loadProfiles(deps.cacheStore);
      const enrichedContext = await enrichContext(deps, context, profiles);
      const results = getRankedArtistRecommendations({
        seed,
        context: enrichedContext,
        snapshot,
        profiles,
        config,
      });

      await deps.resultWriter.writeArtistRanking({
        seed,
        context: enrichedContext,
        results,
      });
      return results;
    },

    async updateAffinityFromPlayback(event) {
      const snapshot = await deps.catalogReader.getSnapshot();
      await updateProfilesFromPlayback({
        cacheStore: deps.cacheStore,
        snapshot,
        config,
        event,
      });
    },

    async updateAffinityFromFavorite(event) {
      const snapshot = await deps.catalogReader.getSnapshot();
      await updateProfilesFromFavorite({
        cacheStore: deps.cacheStore,
        snapshot,
        config,
        event,
      });
    },

    async updateAffinityFromPlaylist(event) {
      const snapshot = await deps.catalogReader.getSnapshot();
      await updateProfilesFromPlaylist({
        cacheStore: deps.cacheStore,
        snapshot,
        config,
        event,
      });
    },

    async updateAffinityFromDislike(event) {
      const snapshot = await deps.catalogReader.getSnapshot();
      await updateProfilesFromDislike({
        cacheStore: deps.cacheStore,
        snapshot,
        config,
        event,
      });
    },
  };
}
