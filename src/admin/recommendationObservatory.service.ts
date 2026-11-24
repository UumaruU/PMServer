import type { PrismaClient } from "@prisma/client";

import { AppError } from "../utils/errors";

type QueryInput = {
  limit?: number;
  offset?: number;
  userId?: string;
  status?: string;
};

function limit(value?: number) {
  return Math.min(200, Math.max(1, Number.isFinite(value) ? Number(value) : 50));
}

function offset(value?: number) {
  return Math.max(0, Number.isFinite(value) ? Number(value) : 0);
}

function countBy<T>(items: T[], readKey: (item: T) => string | string[] | null | undefined) {
  return items.reduce<Record<string, number>>((accumulator, item) => {
    const rawKey = readKey(item);
    const keys = Array.isArray(rawKey) ? rawKey : rawKey ? [rawKey] : [];
    keys.forEach((key) => {
      accumulator[key] = (accumulator[key] ?? 0) + 1;
    });
    return accumulator;
  }, {});
}

function distinct(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function buildRequestWhere(query: QueryInput) {
  return {
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.status ? { status: query.status } : {}),
  };
}

async function getRequestOrThrow(prisma: PrismaClient, id: string) {
  const request = await prisma.recommendationRequest.findUnique({
    where: {
      id,
    },
  });

  if (!request) {
    throw new AppError(404, "NOT_FOUND", "Recommendation request was not found.");
  }

  return request;
}

async function getRequestTraceParts(prisma: PrismaClient, id: string) {
  const [request, candidates, scoreBreakdowns, filterLogs, featureSnapshots, reasonSnapshots, poolHealthSnapshots, discoveryJobLogs, providerResultLogs, graphEdges] =
    await Promise.all([
      getRequestOrThrow(prisma, id),
      prisma.recommendationCandidateSnapshot.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: [
          {
            stage: "asc",
          },
          {
            rank: "asc",
          },
          {
            createdAt: "asc",
          },
        ],
      }),
      prisma.recommendationScoreBreakdown.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: [
          {
            rank: "asc",
          },
          {
            finalScore: "desc",
          },
        ],
      }),
      prisma.recommendationFilterLog.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: [
          {
            createdAt: "asc",
          },
          {
            canonicalTrackId: "asc",
          },
        ],
      }),
      prisma.recommendationFeatureSnapshot.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: [
          {
            entityType: "asc",
          },
          {
            createdAt: "asc",
          },
        ],
      }),
      prisma.recommendationReasonSnapshot.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: [
          {
            reasonType: "asc",
          },
          {
            createdAt: "asc",
          },
        ],
      }),
      prisma.poolHealthSnapshot.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      prisma.discoveryJobLog.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      prisma.providerResultLog.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      prisma.graphEdgeAudit.findMany({
        where: {
          recommendationRequestId: id,
        },
        orderBy: {
          createdAt: "asc",
        },
      }),
    ]);

  return {
    request,
    candidates,
    scoreBreakdowns,
    filterLogs,
    featureSnapshots,
    reasonSnapshots,
    poolHealthSnapshots,
    discoveryJobLogs,
    providerResultLogs,
    graphEdges,
  };
}

function buildGraphFromAudits(graphEdges: Array<{
  id: string;
  sourceNodeType: string;
  sourceNodeId: string;
  targetNodeType: string;
  targetNodeId: string;
  edgeType: string;
  candidateTrackId?: string | null;
  weight?: number | null;
  confidence?: number | null;
  reason?: string | null;
  evidence?: unknown;
}>) {
  const nodesById = new Map<string, { id: string; type: string; entityId: string }>();
  const makeNodeId = (type: string, entityId: string) => `${type}:${entityId}`;

  graphEdges.forEach((edge) => {
    const source = makeNodeId(edge.sourceNodeType, edge.sourceNodeId);
    const target = makeNodeId(edge.targetNodeType, edge.targetNodeId);
    nodesById.set(source, {
      id: source,
      type: edge.sourceNodeType,
      entityId: edge.sourceNodeId,
    });
    nodesById.set(target, {
      id: target,
      type: edge.targetNodeType,
      entityId: edge.targetNodeId,
    });

    if (edge.candidateTrackId) {
      const candidateNode = makeNodeId("RecommendationCandidate", edge.candidateTrackId);
      nodesById.set(candidateNode, {
        id: candidateNode,
        type: "RecommendationCandidate",
        entityId: edge.candidateTrackId,
      });
    }
  });

  return {
    nodes: [...nodesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: graphEdges.map((edge) => ({
      id: edge.id,
      type: edge.edgeType,
      source: makeNodeId(edge.sourceNodeType, edge.sourceNodeId),
      target: makeNodeId(edge.targetNodeType, edge.targetNodeId),
      candidateTrackId: edge.candidateTrackId ?? null,
      weight: edge.weight ?? null,
      confidence: edge.confidence ?? null,
      reason: edge.reason ?? null,
      evidence: edge.evidence ?? null,
    })),
  };
}

async function getTrackEdges(prisma: PrismaClient, trackId: string) {
  return prisma.trackEdge.findMany({
    where: {
      OR: [
        {
          sourceTrackId: trackId,
        },
        {
          targetTrackId: trackId,
        },
      ],
    },
    include: {
      sourceTrack: true,
      targetTrack: true,
      artist: true,
    },
    orderBy: [
      {
        weight: "desc",
      },
      {
        id: "asc",
      },
    ],
  });
}

async function getArtistSimilarities(prisma: PrismaClient, artistId: string) {
  return prisma.artistSimilarity.findMany({
    where: {
      OR: [
        {
          sourceArtistId: artistId,
        },
        {
          targetArtistId: artistId,
        },
      ],
    },
    include: {
      sourceArtist: true,
      targetArtist: true,
    },
    orderBy: [
      {
        score: "desc",
      },
      {
        id: "asc",
      },
    ],
  });
}

export const recommendationObservatoryService = {
  async listRecommendationRequests(prisma: PrismaClient, query: QueryInput = {}) {
    const take = limit(query.limit);
    const skip = offset(query.offset);
    const where = buildRequestWhere(query);
    const [items, total] = await Promise.all([
      prisma.recommendationRequest.findMany({
        where,
        orderBy: {
          createdAt: "desc",
        },
        take,
        skip,
      }),
      prisma.recommendationRequest.count({
        where,
      }),
    ]);

    return {
      items,
      pagination: {
        total,
        limit: take,
        offset: skip,
      },
    };
  },

  async getRecommendationRequest(prisma: PrismaClient, id: string) {
    return getRequestTraceParts(prisma, id);
  },

  async getRecommendationFunnel(prisma: PrismaClient, id: string) {
    const trace = await getRequestTraceParts(prisma, id);
    const generated = trace.candidates.filter((candidate) => candidate.stage === "generated");
    const final = trace.candidates.filter((candidate) => candidate.stage === "final" || candidate.isFinal);
    const filteredIds = new Set(trace.filterLogs.map((log) => log.canonicalTrackId).filter(Boolean));
    const scoredIds = distinct(trace.scoreBreakdowns.map((score) => score.canonicalTrackId));
    const remainingCandidateIds = scoredIds.filter((trackId) => !filteredIds.has(trackId));

    return {
      requestId: id,
      generatedCandidateCount: generated.length,
      generatedCandidateCountBySource: countBy(generated, (candidate) => candidate.sourceChannels),
      filteredCandidateCount: trace.filterLogs.length,
      filteredCandidateCountByReason: countBy(trace.filterLogs, (log) => log.reason),
      remainingCandidateCount: remainingCandidateIds.length || Math.max(0, trace.scoreBreakdowns.length - trace.filterLogs.length),
      finalReturnedTrackCount: final.length || (Array.isArray(trace.request.finalRecommendations) ? trace.request.finalRecommendations.length : 0),
      finalReturnedTrackIds: distinct(final.map((candidate) => candidate.canonicalTrackId)),
      poolHealth: trace.poolHealthSnapshots[0] ?? null,
    };
  },

  async getRecommendationCandidates(prisma: PrismaClient, id: string) {
    const trace = await getRequestTraceParts(prisma, id);

    return {
      requestId: id,
      candidates: trace.candidates,
      scoreBreakdowns: trace.scoreBreakdowns,
      featureSnapshots: trace.featureSnapshots,
      reasonSnapshots: trace.reasonSnapshots,
    };
  },

  async getRecommendationFiltered(prisma: PrismaClient, id: string) {
    await getRequestOrThrow(prisma, id);
    const items = await prisma.recommendationFilterLog.findMany({
      where: {
        recommendationRequestId: id,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return {
      requestId: id,
      items,
      countByReason: countBy(items, (item) => item.reason),
    };
  },

  async getRecommendationGraph(prisma: PrismaClient, id: string) {
    await getRequestOrThrow(prisma, id);
    const graphEdges = await prisma.graphEdgeAudit.findMany({
      where: {
        recommendationRequestId: id,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return {
      requestId: id,
      ...buildGraphFromAudits(graphEdges),
    };
  },

  async getUserRecommendationProfile(prisma: PrismaClient, userId: string) {
    const profile = await prisma.userRecommendationProfile.findUnique({
      where: {
        userId,
      },
    });

    return {
      userId,
      profile,
    };
  },

  async getUserPoolHealth(prisma: PrismaClient, userId: string, query: QueryInput = {}) {
    const take = limit(query.limit);
    const items = await prisma.poolHealthSnapshot.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take,
      skip: offset(query.offset),
    });

    return {
      userId,
      latest: items[0] ?? null,
      items,
    };
  },

  async listDiscoveryJobs(prisma: PrismaClient, query: QueryInput = {}) {
    const take = limit(query.limit);
    const skip = offset(query.offset);
    const where = query.status ? { status: query.status as never } : {};
    const [items, total] = await Promise.all([
      prisma.discoveryJob.findMany({
        where,
        include: {
          seed: true,
        },
        orderBy: [
          {
            priority: "desc",
          },
          {
            createdAt: "desc",
          },
        ],
        take,
        skip,
      }),
      prisma.discoveryJob.count({
        where,
      }),
    ]);

    return {
      items,
      pagination: {
        total,
        limit: take,
        offset: skip,
      },
    };
  },

  async getDiscoveryJob(prisma: PrismaClient, id: string) {
    const job = await prisma.discoveryJob.findUnique({
      where: {
        id,
      },
      include: {
        seed: true,
      },
    });

    if (!job) {
      throw new AppError(404, "NOT_FOUND", "Discovery job was not found.");
    }

    const logs = await prisma.discoveryJobLog.findMany({
      where: {
        discoveryJobId: id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return {
      job,
      logs,
    };
  },

  async getArtistGraph(prisma: PrismaClient, artistId: string) {
    const [artist, similarArtists, trackEdges] = await Promise.all([
      prisma.artist.findUnique({
        where: {
          id: artistId,
        },
        include: {
          sources: true,
          tracks: {
            take: 50,
          },
        },
      }),
      getArtistSimilarities(prisma, artistId),
      prisma.trackEdge.findMany({
        where: {
          artistId,
        },
        include: {
          sourceTrack: true,
          targetTrack: true,
        },
        orderBy: [
          {
            weight: "desc",
          },
          {
            id: "asc",
          },
        ],
      }),
    ]);

    if (!artist) {
      throw new AppError(404, "NOT_FOUND", "Artist was not found.");
    }

    return {
      artist,
      similarArtists,
      trackEdges,
    };
  },

  async getTrackGraph(prisma: PrismaClient, trackId: string) {
    const [track, edges] = await Promise.all([
      prisma.canonicalTrack.findUnique({
        where: {
          id: trackId,
        },
        include: {
          sources: true,
          artists: true,
        },
      }),
      getTrackEdges(prisma, trackId),
    ]);

    if (!track) {
      throw new AppError(404, "NOT_FOUND", "Track was not found.");
    }

    return {
      track,
      edges,
    };
  },

  async getTrackVectorNeighbors(prisma: PrismaClient, trackId: string) {
    const track = await prisma.canonicalTrack.findUnique({
      where: {
        id: trackId,
      },
    });

    if (!track) {
      throw new AppError(404, "NOT_FOUND", "Track was not found.");
    }

    const edges = await getTrackEdges(prisma, trackId);
    const neighbors = edges
      .map((edge) => {
        const isSource = edge.sourceTrackId === trackId;
        const neighborTrack = isSource ? edge.targetTrack : edge.sourceTrack;
        const neighborId = isSource ? edge.targetTrackId : edge.sourceTrackId;
        if (!neighborId) {
          return null;
        }

        return {
          id: neighborId,
          score: edge.weight,
          source: "graph_similarity_proxy",
          edgeType: edge.edgeType,
          track: neighborTrack ?? null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => !!entry);

    return {
      entityType: "track",
      entityId: trackId,
      vectorAvailable: false,
      source: "graph_similarity_proxy",
      neighbors,
    };
  },

  async getArtistVectorNeighbors(prisma: PrismaClient, artistId: string) {
    const artist = await prisma.artist.findUnique({
      where: {
        id: artistId,
      },
    });

    if (!artist) {
      throw new AppError(404, "NOT_FOUND", "Artist was not found.");
    }

    const similarities = await getArtistSimilarities(prisma, artistId);
    const neighbors = similarities.map((similarity) => {
      const isSource = similarity.sourceArtistId === artistId;
      const neighborId = isSource ? similarity.targetArtistId : similarity.sourceArtistId;
      const neighborArtist = isSource ? similarity.targetArtist : similarity.sourceArtist;

      return {
        id: neighborId,
        score: similarity.score,
        source: "artist_similarity_proxy",
        providerId: similarity.providerId,
        reason: similarity.reason,
        artist: neighborArtist,
      };
    });

    return {
      entityType: "artist",
      entityId: artistId,
      vectorAvailable: false,
      source: "artist_similarity_proxy",
      neighbors,
    };
  },
};
