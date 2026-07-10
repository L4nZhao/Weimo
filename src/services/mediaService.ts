import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../lib/config.js";
import { localDateString } from "../lib/dates.js";
import { mediaDir, toPublicMediaUrl } from "../lib/paths.js";
import { prisma } from "../lib/prisma.js";
import { isFlexibleTextMatch } from "../lib/textMatch.js";
import { cosineSimilarity, embedText, parseEmbedding } from "./embeddingService.js";
import { summarizeFileDescription } from "./fileDescriptionService.js";
import { hasImageRecognition, recognizeImage } from "./imageRecognitionService.js";
import { ensureWechatUser } from "./userService.js";

export type MediaType = "image" | "voice" | "file" | "video";

const EXT_BY_TYPE: Record<MediaType, string> = {
  image: ".jpg",
  voice: ".silk",
  file: "",
  video: ".mp4"
};

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".silk": "audio/silk",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

export async function persistMedia(input: {
  bytes: Uint8Array;
  mediaType: MediaType;
  fileName?: string;
}) {
  const date = localDateString();
  const dir = path.join(mediaDir, input.mediaType, date);
  await fs.mkdir(dir, { recursive: true });

  const originalName = sanitizeFileName(input.fileName);
  const ext = getExtension(originalName, input.mediaType);
  const fileName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, input.bytes);

  return {
    fileName: originalName || fileName,
    filePath,
    publicUrl: toPublicMediaUrl(filePath, config.publicBaseUrl),
    mimeType: MIME_BY_EXT[ext.toLowerCase()],
    fileSize: input.bytes.byteLength
  };
}

export async function createMediaRecord(input: {
  wechatUserId: string;
  memberName?: string;
  mediaType: MediaType;
  fileName: string;
  filePath: string;
  publicUrl: string;
  mimeType?: string;
  fileSize?: number;
  sourceMessageId?: string;
  caption?: string;
  metadata?: Record<string, unknown>;
}) {
  const user = await ensureWechatUser(input.wechatUserId, input.memberName);
  const fileName = await ensureUniqueMediaFileName({
    wechatUserId: input.wechatUserId,
    fileName: input.fileName
  });
  const caption =
    input.caption ||
    summarizeFileDescription({
      fileName,
      mediaType: input.mediaType,
      metadata: input.metadata
    });
  return prisma.mediaFile.create({
    data: {
      userId: user.id,
      wechatUserId: input.wechatUserId,
      mediaType: input.mediaType,
      fileName,
      filePath: input.filePath,
      publicUrl: input.publicUrl,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      sourceMessageId: input.sourceMessageId,
      caption,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined
    }
  });
}

async function ensureUniqueMediaFileName(input: { wechatUserId: string; fileName: string }) {
  const cleanName = sanitizeFileName(input.fileName) || `file-${Date.now()}`;
  const ext = path.extname(cleanName);
  const base = ext ? cleanName.slice(0, -ext.length) : cleanName;
  let candidate = cleanName;
  let suffix = 2;
  while (
    await prisma.mediaFile.findFirst({
      where: {
        wechatUserId: input.wechatUserId,
        fileName: candidate
      },
      select: { id: true }
    })
  ) {
    candidate = `${base} (${suffix})${ext}`;
    suffix += 1;
  }
  return candidate;
}

export async function listRecentMedia(input: {
  wechatUserId?: string;
  mediaType?: string;
  limit?: number;
}) {
  return prisma.mediaFile.findMany({
    where: {
      ...(input.wechatUserId ? { wechatUserId: input.wechatUserId } : {}),
      ...(input.mediaType ? { mediaType: input.mediaType } : {})
    },
    orderBy: { createdAt: "desc" },
    take: input.limit ?? 50
  });
}

export async function recognizeAndIndexImageMedia(mediaId: string) {
  const record = await prisma.mediaFile.findUnique({
    where: { id: mediaId }
  });
  if (!record || record.mediaType !== "image") {
    return record;
  }

  let recognitionText = record.caption;
  if (hasImageRecognition()) {
    recognitionText = await recognizeImage(record.filePath);
  }
  if (!recognitionText) {
    return record;
  }

  const metadata = parseMetadata(record.metadataJson);
  if (!metadata.fullCaption || metadata.fullCaption === record.caption) {
    metadata.fullCaption = recognitionText;
  }
  const caption = summarizeFileDescription({
    fileName: record.fileName,
    mediaType: record.mediaType,
    text: recognitionText,
    metadata
  });
  const embedding = await embedText(buildImageIndexText(record.fileName, recognitionText));
  return prisma.mediaFile.update({
    where: { id: record.id },
    data: {
      caption,
      embeddingJson: embedding ? JSON.stringify(embedding.embedding) : record.embeddingJson,
      embeddingModel: embedding?.model || record.embeddingModel,
      metadataJson: JSON.stringify(metadata)
    }
  });
}

export async function annotateMediaForSearch(input: { mediaId: string; note: string }) {
  const note = input.note.trim();
  if (!note) {
    return null;
  }

  const record = await prisma.mediaFile.findUnique({
    where: { id: input.mediaId }
  });
  if (!record) {
    return null;
  }

  const metadata = parseMetadata(record.metadataJson);
  const userNotes = Array.isArray(metadata.userNotes)
    ? metadata.userNotes.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  if (!userNotes.includes(note)) {
    userNotes.push(note);
  }
  metadata.userNotes = userNotes.slice(-20);

  const caption = appendSearchNote(record.caption, note);
  const embedding = await embedText(buildMediaIndexText(record.fileName, caption, metadata));
  return prisma.mediaFile.update({
    where: { id: record.id },
    data: {
      caption,
      embeddingJson: embedding ? JSON.stringify(embedding.embedding) : record.embeddingJson,
      embeddingModel: embedding?.model || record.embeddingModel,
      metadataJson: JSON.stringify(metadata)
    }
  });
}

export async function searchMediaByText(input: {
  wechatUserId: string;
  query: string;
  mediaType?: string;
  limit?: number;
}) {
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const candidateTake = Math.min(Math.max(limit * 4, 40), 100);
  const mediaType = input.mediaType;
  const where = {
    wechatUserId: input.wechatUserId,
    ...(mediaType ? { mediaType } : {})
  };

  const [directMatches, candidates, fallbackCandidates, queryEmbedding] = await Promise.all([
    prisma.mediaFile.findMany({
      where: {
        ...where,
        OR: [
          { caption: { contains: query } },
          { fileName: { contains: query } },
          { mediaType: { contains: query } },
          { metadataJson: { contains: query } }
        ]
      },
      orderBy: { createdAt: "desc" },
      take: limit
    }),
    prisma.mediaFile.findMany({
      where: {
        ...where,
        caption: { not: null },
        embeddingJson: { not: null }
      },
      orderBy: { createdAt: "desc" },
      take: candidateTake
    }),
    prisma.mediaFile.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: candidateTake
    }),
    embedText(query)
  ]);

  const directIds = new Set(directMatches.map((item) => item.id));
  const semanticMatches =
    queryEmbedding?.embedding
      ? candidates
          .map((item) => ({
            item,
            score: cosineSimilarity(queryEmbedding.embedding, parseEmbedding(item.embeddingJson) || [])
          }))
          .filter((result) => result.score > 0)
          .sort((left, right) => right.score - left.score)
          .map((result) => result.item)
      : [];

  const merged = [...directMatches];
  for (const item of semanticMatches) {
    if (!directIds.has(item.id)) {
      merged.push(item);
      directIds.add(item.id);
    }
    if (merged.length >= limit) {
      break;
    }
  }

  if (merged.length < limit) {
    const flexibleMatches = fallbackCandidates.filter((item) =>
      isFlexibleMediaMatch(query, [item.fileName, item.caption || "", item.metadataJson || "", item.publicUrl].join("\n"))
    );
    for (const item of flexibleMatches) {
      if (!directIds.has(item.id)) {
        merged.push(item);
        directIds.add(item.id);
      }
      if (merged.length >= limit) {
        break;
      }
    }
  }

  return merged.slice(0, limit);
}

function buildImageIndexText(fileName: string, caption: string) {
  return [fileName, caption].filter(Boolean).join("\n");
}

function buildMediaIndexText(fileName: string, caption: string, metadata: Record<string, unknown>) {
  const userNotes = Array.isArray(metadata.userNotes) ? metadata.userNotes.join("\n") : "";
  const fullCaption = typeof metadata.fullCaption === "string" ? metadata.fullCaption : "";
  return [fileName, caption, fullCaption, userNotes].filter(Boolean).join("\n");
}

function appendSearchNote(caption: string | null, note: string) {
  const searchNote = `用户备注：${note}`;
  const current = caption?.trim();
  if (!current) {
    return searchNote;
  }
  if (current.includes(searchNote) || current.includes(note)) {
    return current;
  }
  return `${current}\n${searchNote}`.slice(0, 4000);
}

const MEDIA_SEARCH_STOPWORDS = /有关|关于|一个|一份|一篇|介绍|报告|文件|文档|材料|方案|总结|图片|照片|截图|语音|视频|媒体/g;

function isFlexibleMediaMatch(query: string, text: string) {
  return isFlexibleTextMatch(query, text, MEDIA_SEARCH_STOPWORDS);
}

function sanitizeFileName(fileName?: string) {
  return fileName?.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function getExtension(fileName: string | undefined, mediaType: MediaType) {
  const ext = fileName ? path.extname(fileName) : "";
  return ext || EXT_BY_TYPE[mediaType];
}

export function parseMetadata(value: string | null) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseGeneratedMediaSource(metadataJson: string | null): "generated-document" | "media" {
  return parseMetadata(metadataJson).source === "generated-document" ? "generated-document" : "media";
}
