import type { Prisma } from "@prisma/client";
import { config } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { extractHanAsciiTerms, normalizeForMatch, termsOverlapMatch } from "../lib/textMatch.js";
import { cosineSimilarity, embedText, parseEmbedding } from "./embeddingService.js";
import { ensureWechatUser } from "./userService.js";

export async function storeMemory(input: {
  wechatUserId: string;
  memberName?: string;
  content: string;
  category?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  const content = input.content.trim();
  if (!content) {
    throw new Error("记忆内容不能为空。");
  }

  const user = await ensureWechatUser(input.wechatUserId, input.memberName);
  const embedding = await embedText(content);

  return prisma.memoryEntry.create({
    data: {
      userId: user.id,
      wechatUserId: input.wechatUserId,
      category: input.category || "general",
      content,
      source: input.source || "manual",
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined,
      embeddingJson: embedding ? JSON.stringify(embedding.embedding) : undefined,
      embeddingModel: embedding?.model
    }
  });
}

export async function autoStoreMemory(input: {
  wechatUserId: string;
  memberName?: string;
  content: string;
}) {
  const content = input.content.trim();
  if (!shouldAutoStoreMemory(content)) {
    return null;
  }

  return storeMemory({
    wechatUserId: input.wechatUserId,
    memberName: input.memberName,
    content,
    category: "chat",
    source: "chat"
  }).catch((error) => {
    console.error("Failed to auto-store memory", error);
    return null;
  });
}

function shouldAutoStoreMemory(content: string) {
  if (content.length < config.memoryAutoSaveMinLength) {
    return false;
  }
  if (/用户随消息发送了以下媒体文件/.test(content)) {
    return false;
  }
  if (/(记住|以后|偏好|常用|默认|我喜欢|我希望|我的项目|我的需求|知识库|保存|记录)/.test(content)) {
    return true;
  }
  return content.length >= 80;
}

export async function searchMemories(input: {
  wechatUserId: string;
  query: string;
  category?: string;
  limit?: number;
}) {
  const query = input.query.trim();
  const limit = input.limit ?? 5;
  const candidateTake = Math.min(Math.max(limit * 4, 40), 100);
  if (!query) {
    return [];
  }

  const where: Prisma.MemoryEntryWhereInput = {
    wechatUserId: input.wechatUserId,
    ...(input.category ? { category: input.category } : {})
  };

  const direct = await prisma.memoryEntry.findMany({
    where: {
      ...where,
      OR: [{ content: { contains: query } }, { category: { contains: query } }]
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });

  const remaining = Math.max(limit - direct.length, 0);
  if (remaining <= 0) {
    return direct;
  }

  const directIds = new Set(direct.map((entry) => entry.id));
  const fuzzyCandidates = await prisma.memoryEntry.findMany({
    where: {
      ...where,
      id: { notIn: [...directIds] }
    },
    orderBy: { createdAt: "desc" },
    take: candidateTake
  });
  const fuzzy = fuzzyCandidates.filter((entry) => isFlexibleMemoryMatch(query, entry.content)).slice(0, remaining);
  for (const entry of fuzzy) {
    directIds.add(entry.id);
  }
  if (direct.length + fuzzy.length >= limit) {
    return [...direct, ...fuzzy];
  }

  const queryEmbedding = await embedText(query);
  if (!queryEmbedding) {
    return [...direct, ...fuzzy];
  }

  const candidates = await prisma.memoryEntry.findMany({
    where: {
      ...where,
      embeddingJson: { not: null },
      id: { notIn: [...directIds] }
    },
    orderBy: { createdAt: "desc" },
    take: candidateTake
  });

  const semantic = candidates
    .map((entry) => ({
      entry,
      score: cosineSimilarity(queryEmbedding.embedding, parseEmbedding(entry.embeddingJson) || [])
    }))
    .filter((item) => item.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit - direct.length - fuzzy.length, 0))
    .map((item) => item.entry);

  return [...direct, ...fuzzy, ...semantic];
}

const MEMORY_SEARCH_STOPWORDS = /查询|搜索|检索|查找|帮我|一下|关于|有关|记录|记忆|历史/g;

function isFlexibleMemoryMatch(query: string, content: string) {
  const normalizedQuery = normalizeForMatch(query, MEMORY_SEARCH_STOPWORDS);
  const normalizedContent = normalizeForMatch(content, MEMORY_SEARCH_STOPWORDS);
  if (!normalizedQuery || !normalizedContent) {
    return false;
  }
  if (normalizedContent.includes(normalizedQuery)) {
    return true;
  }
  const terms = extractHanAsciiTerms(normalizedQuery, { trigrams: false, shortChunkSkipsGrams: false });
  return termsOverlapMatch(terms, normalizedContent);
}

export async function listRecentMemories(input: {
  wechatUserId: string;
  limit?: number;
}) {
  return prisma.memoryEntry.findMany({
    where: { wechatUserId: input.wechatUserId },
    orderBy: { createdAt: "desc" },
    take: input.limit ?? 10
  });
}
