import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { cosineSimilarity, embedText, parseEmbedding } from "./embeddingService.js";

export async function searchReports(input: {
  keyword?: string;
  member?: string;
  project?: string;
  templateId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  requesterWechatUserId?: string;
}) {
  const baseWhere: Prisma.ReportWhereInput = {};
  const filters: Prisma.ReportWhereInput[] = [];
  const keyword = input.keyword?.trim();

  if (keyword) {
    filters.push(buildKeywordWhere(keyword));
  }

  if (input.member) {
    filters.push({ user: { name: { contains: input.member } } });
  }

  if (input.project) {
    filters.push({ project: { name: { contains: input.project } } });
  }

  if (input.templateId) {
    filters.push({ templateId: input.templateId });
  }

  if (input.requesterWechatUserId) {
    const requester = await prisma.user.findUnique({
      where: { wechatUserId: input.requesterWechatUserId }
    });
    if (!requester) {
      return [];
    }
    if (!canManage(requester.role)) {
      filters.push({ userId: requester.id });
    }
  }

  if (input.from || input.to) {
    filters.push({
      createdAt: {
        gte: input.from ? new Date(input.from) : undefined,
        lte: input.to ? new Date(input.to) : undefined
      }
    });
  }

  if (filters.length) {
    baseWhere.AND = filters;
  }

  const directReports = await prisma.report.findMany({
    where: baseWhere,
    include: { user: true, project: true, template: true },
    orderBy: { createdAt: "desc" },
    skip: input.offset ?? 0,
    take: input.limit ?? 20
  });

  if (!keyword) {
    return directReports;
  }

  const semanticReports = await searchReportsByEmbedding({
    keyword,
    input,
    excludeIds: new Set(directReports.map((report) => report.id)),
    take: Math.max((input.limit ?? 20) - directReports.length, 0)
  });

  return [...directReports, ...semanticReports].slice(0, input.limit ?? 20);
}

export function canManage(role: string) {
  return role === "admin";
}

function buildKeywordWhere(keyword: string): Prisma.ReportWhereInput {
  return {
    OR: [
      { title: { contains: keyword } },
      { rawText: { contains: keyword } },
      { summary: { contains: keyword } },
      { keywords: { contains: keyword } },
      { user: { name: { contains: keyword } } },
      { project: { name: { contains: keyword } } }
    ]
  };
}

async function searchReportsByEmbedding(input: {
  keyword: string;
  input: {
    member?: string;
    project?: string;
    templateId?: string;
    from?: string;
    to?: string;
  };
  excludeIds: Set<string>;
  take: number;
}) {
  if (input.take <= 0) {
    return [];
  }

  const queryEmbedding = await embedText(input.keyword);
  if (!queryEmbedding) {
    return [];
  }
  const candidateTake = Math.min(Math.max(input.take * 4, 40), 100);

  const filters: Prisma.ReportWhereInput[] = [{ embeddingJson: { not: null } }];
  if (input.input.member) {
    filters.push({ user: { name: { contains: input.input.member } } });
  }
  if (input.input.project) {
    filters.push({ project: { name: { contains: input.input.project } } });
  }
  if (input.input.templateId) {
    filters.push({ templateId: input.input.templateId });
  }
  if (input.input.from || input.input.to) {
    filters.push({
      createdAt: {
        gte: input.input.from ? new Date(input.input.from) : undefined,
        lte: input.input.to ? new Date(input.input.to) : undefined
      }
    });
  }
  const candidates = await prisma.report.findMany({
    where: { AND: filters },
    include: { user: true, project: true, template: true },
    orderBy: { createdAt: "desc" },
    take: candidateTake
  });

  return candidates
    .filter((report) => !input.excludeIds.has(report.id))
    .map((report) => ({
      report,
      score: cosineSimilarity(queryEmbedding.embedding, parseEmbedding(report.embeddingJson) || [])
    }))
    .filter((item) => item.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.take)
    .map((item) => item.report);
}
