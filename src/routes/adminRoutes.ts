import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import mammoth from "mammoth";
import multer from "multer";
import { z } from "zod";
import { config } from "../lib/config.js";
import { localDateString } from "../lib/dates.js";
import { mediaDir, reportsDir, storageRoot, templatesDir, toSignedMediaUrl, toSignedStorageUrl } from "../lib/paths.js";
import { prisma } from "../lib/prisma.js";
import { requireAdminApi } from "../services/authService.js";
import { summarizeFileDescription } from "../services/fileDescriptionService.js";
import {
  createIlinkBotQrSession,
  deleteIlinkBot,
  getIlinkBot,
  getIlinkBotQrSession,
  listIlinkBots,
  pollIlinkUpdates,
  refreshIlinkLoginStatus,
  refreshIlinkQrSession
} from "../services/ilinkService.js";
import { parseMetadata } from "../services/mediaService.js";
import { searchReports } from "../services/reportService.js";
import type { Skill } from "../services/skillTypes.js";
import { listRecentMemories, searchMemories } from "../services/memoryService.js";
import { loadSkills, reloadSkills } from "../services/skillLoader.js";
import { DEFAULT_TEMPLATE_FIELDS } from "../services/templateService.js";

const router = Router();
const upload = multer({ dest: templatesDir });

router.use(requireAdminApi);

const reportQuerySchema = z.object({
  keyword: z.string().optional(),
  member: z.string().optional(),
  project: z.string().optional(),
  templateId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

router.get("/reports", async (req, res, next) => {
  try {
    const query = reportQuerySchema.parse(req.query);
    const reports = await searchReports(query);
    res.json({
      pagination: {
        limit: query.limit ?? 20,
        offset: query.offset ?? 0,
        hasMore: reports.length === (query.limit ?? 20)
      },
      items: reports.map((report) => ({
        id: report.id,
        title: displayReportTitle(report.title, displayWechatUserName(report.user.name)),
        memberName: displayWechatUserName(report.user.name),
        projectName: report.project?.name ?? null,
        templateName: report.template?.name ?? null,
        summary: report.summary,
        status: report.status,
        createdAt: report.createdAt,
        downloadUrl: toSignedStorageUrl(report.wordFilePath, config.publicBaseUrl)
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get("/reports/:id", async (req, res, next) => {
  try {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: { user: true, project: true, template: true, attachments: true }
    });

    if (!report) {
      res.status(404).json({ error: "Report not found" });
      return;
    }

    res.json({
      ...report,
      downloadUrl: toSignedStorageUrl(report.wordFilePath, config.publicBaseUrl)
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/reports/:id", async (req, res, next) => {
  try {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: { attachments: true }
    });

    if (!report) {
      res.status(404).json({ error: "Report not found" });
      return;
    }

    await prisma.attachment.deleteMany({ where: { reportId: report.id } });
    await prisma.report.delete({ where: { id: report.id } });
    await trashFileBestEffort(report.wordFilePath);
    await Promise.all(report.attachments.map((attachment) => trashFileBestEffort(attachment.filePath)));

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/templates", async (_req, res, next) => {
  try {
    const templates = await prisma.template.findMany({
      orderBy: { createdAt: "desc" }
    });
    res.json({ items: templates });
  } catch (error) {
    next(error);
  }
});

router.get("/templates/:id/preview", async (req, res, next) => {
  try {
    const template = await prisma.template.findUnique({
      where: { id: req.params.id }
    });

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    if (!template.templateFilePath) {
      res.json({
        template,
        html: renderFallbackTemplatePreview(),
        warnings: ["当前模板未上传 .docx 文件，报告会使用系统兜底表格生成。"]
      });
      return;
    }

    const result = await mammoth.convertToHtml({ path: template.templateFilePath });
    res.json({
      template,
      html: result.value,
      warnings: result.messages.map((message) => message.message)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/templates", upload.single("file"), async (req, res, next) => {
  try {
    await fs.mkdir(templatesDir, { recursive: true });
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        fieldsJson: z.string().optional(),
        isActive: z.coerce.boolean().optional()
      })
      .parse(req.body);

    const file = req.file;
    if (file && path.extname(file.originalname).toLowerCase() !== ".docx") {
      await fs.unlink(file.path).catch(() => undefined);
      res.status(400).json({ error: "模板文件只支持 .docx 格式" });
      return;
    }

    const templateFilePath = file ? await normalizeUploadedTemplate(file.path, file.originalname) : null;
    const fieldsJson = body.fieldsJson ? JSON.stringify(JSON.parse(body.fieldsJson)) : JSON.stringify(DEFAULT_TEMPLATE_FIELDS);

    const template = await prisma.template.create({
      data: {
        name: body.name,
        description: body.description,
        templateFilePath,
        fieldsJson,
        isActive: body.isActive ?? true
      }
    });

    res.status(201).json(template);
  } catch (error) {
    next(error);
  }
});

router.patch("/templates/:id", async (req, res, next) => {
  try {
    const payload = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        isActive: z.boolean().optional()
      })
      .parse(req.body);
    const template = await prisma.template.update({
      where: { id: req.params.id },
      data: payload
    });
    res.json(template);
  } catch (error) {
    next(error);
  }
});

router.delete("/templates/:id", async (req, res, next) => {
  try {
    const reportCount = await prisma.report.count({
      where: { templateId: req.params.id }
    });
    if (reportCount > 0) {
      res.status(409).json({ error: "模板已有报告引用，不能删除，可改为停用。" });
      return;
    }

    const template = await prisma.template.delete({ where: { id: req.params.id } });
    if (template.templateFilePath) {
      await trashFileBestEffort(template.templateFilePath);
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/users", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      include: { project: true },
      orderBy: { createdAt: "desc" }
    });
    res.json({ items: users });
  } catch (error) {
    next(error);
  }
});

router.get("/projects", async (_req, res, next) => {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: "desc" }
    });
    res.json({ items: projects });
  } catch (error) {
    next(error);
  }
});

router.get("/memories", async (req, res, next) => {
  try {
    const query = z
      .object({
        wechatUserId: z.string().optional(),
        q: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).optional()
      })
      .parse(req.query);
    const wechatUserId = query.wechatUserId || "admin";
    const items = query.q
      ? await searchMemories({ wechatUserId, query: query.q, limit: query.limit })
      : await listRecentMemories({ wechatUserId, limit: query.limit });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

router.get("/media", async (req, res, next) => {
  try {
    const query = z
      .object({
        wechatUserId: z.string().optional(),
        mediaType: z.string().optional(),
        q: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional()
      })
      .parse(req.query);

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const keyword = query.q?.trim();
    const mediaWhere = {
      ...(query.wechatUserId ? { wechatUserId: query.wechatUserId } : {}),
      ...(query.mediaType && query.mediaType !== "report" && query.mediaType !== "any" ? { mediaType: query.mediaType } : {}),
      ...(keyword
        ? {
            OR: [
              { fileName: { contains: keyword } },
              { caption: { contains: keyword } },
              { metadataJson: { contains: keyword } },
              { publicUrl: { contains: keyword } }
            ]
          }
        : {})
    };
    const wantsReports = !query.mediaType || query.mediaType === "any" || query.mediaType === "file" || query.mediaType === "report";
    const wantsMedia = !query.mediaType || query.mediaType === "any" || query.mediaType !== "report";
    const [mediaItems, reports] = await Promise.all([
      wantsMedia
        ? prisma.mediaFile.findMany({
            where: mediaWhere,
            include: { user: true },
            orderBy: { createdAt: "desc" },
            skip: offset,
            take: limit
          })
        : Promise.resolve([]),
      wantsReports
        ? prisma.report.findMany({
            where: {
              ...(query.wechatUserId ? { user: { wechatUserId: query.wechatUserId } } : {}),
              ...(keyword
                ? {
                    OR: [
                      { title: { contains: keyword } },
                      { rawText: { contains: keyword } },
                      { summary: { contains: keyword } },
                      { keywords: { contains: keyword } },
                      { user: { name: { contains: keyword } } },
                      { project: { name: { contains: keyword } } }
                    ]
                  }
                : {})
            },
            include: { user: true, project: true, template: true },
            orderBy: { createdAt: "desc" },
            skip: offset,
            take: limit
          })
        : Promise.resolve([])
    ]);

    const items = disambiguateFileItems([
      ...mediaItems.map((item) => {
        const metadata = parseMetadata(item.metadataJson);
        const userName = displayWechatUserName(item.user.name);
        return {
          id: item.id,
          kind: "media",
          fileName: item.fileName,
          mediaType: item.mediaType,
          mimeType: item.mimeType,
          fileSize: item.fileSize,
          source: resolveMediaSource(metadata),
          userName,
          wechatUserId: item.wechatUserId,
          sourceMessageId: item.sourceMessageId,
          caption: summarizeFileDescription({
            fileName: item.fileName,
            mediaType: item.mediaType,
            text: item.caption,
            metadata
          }),
          metadata,
          storagePath: toReadableStoragePath(item.filePath),
          publicUrl: toSignedMediaUrl(item.filePath, config.publicBaseUrl),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        };
      }),
      ...reports.map((report) => {
        const userName = displayWechatUserName(report.user.name);
        const title = displayReportTitle(report.title, userName);
        return {
          id: report.id,
          kind: "report",
          fileName: `${title}.docx`,
          mediaType: "file",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          fileSize: null,
          source: "project-report",
          userName,
          wechatUserId: report.user.wechatUserId,
          sourceMessageId: null,
          caption: summarizeFileDescription({
            fileName: `${title}.docx`,
            mediaType: "file",
            text: report.summary,
            metadata: {
              title,
              projectName: report.project?.name ?? null,
              templateName: report.template?.name ?? null,
              keywords: report.keywords
            }
          }),
          metadata: {
            title,
            originalTitle: report.title,
            projectName: report.project?.name ?? null,
            templateName: report.template?.name ?? null,
            keywords: report.keywords,
            status: report.status
          },
          storagePath: toReadableStoragePath(report.wordFilePath),
          publicUrl: toSignedStorageUrl(report.wordFilePath, config.publicBaseUrl),
          createdAt: report.createdAt,
          updatedAt: report.updatedAt
        };
      })
    ])
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, limit);

    res.json({
      pagination: {
        limit,
        offset,
        hasMore: items.length === limit
      },
      items
    });
  } catch (error) {
    next(error);
  }
});

router.get("/media/:kind/:id/preview", async (req, res, next) => {
  try {
    const payload = z
      .object({
        kind: z.enum(["media", "report"]),
        id: z.string().min(1)
      })
      .parse(req.params);

    if (payload.kind === "media") {
      const media = await prisma.mediaFile.findUnique({ where: { id: payload.id } });
      if (!media) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      res.json(
        await buildFilePreview({
          filePath: media.filePath,
          fileName: media.fileName,
          publicUrl: toSignedMediaUrl(media.filePath, config.publicBaseUrl),
          mimeType: media.mimeType || undefined
        })
      );
      return;
    }

    const report = await prisma.report.findUnique({
      where: { id: payload.id },
      include: { user: true }
    });
    if (!report) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const userName = displayWechatUserName(report.user.name);
    const title = displayReportTitle(report.title, userName);
    res.json(
      await buildFilePreview({
        filePath: report.wordFilePath,
        fileName: `${title}.docx`,
        publicUrl: toSignedStorageUrl(report.wordFilePath, config.publicBaseUrl),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    );
  } catch (error) {
    next(error);
  }
});

router.delete("/media/:kind/:id", async (req, res, next) => {
  try {
    const payload = z
      .object({
        kind: z.enum(["media", "report"]),
        id: z.string().min(1)
      })
      .parse(req.params);

    if (payload.kind === "media") {
      const media = await prisma.mediaFile.findUnique({ where: { id: payload.id } });
      if (!media) {
        res.status(404).json({ error: "Media file not found" });
        return;
      }
      await prisma.mediaFile.delete({ where: { id: media.id } });
      await trashFileBestEffort(media.filePath);
      res.json({ ok: true });
      return;
    }

    const report = await prisma.report.findUnique({
      where: { id: payload.id },
      include: { attachments: true }
    });
    if (!report) {
      res.status(404).json({ error: "Report not found" });
      return;
    }
    await prisma.attachment.deleteMany({ where: { reportId: report.id } });
    await prisma.report.delete({ where: { id: report.id } });
    await trashFileBestEffort(report.wordFilePath);
    await Promise.all(report.attachments.map((attachment) => trashFileBestEffort(attachment.filePath)));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/skills", async (_req, res, next) => {
  try {
    res.json({ items: await buildSkillListItems(await loadSkills()) });
  } catch (error) {
    next(error);
  }
});

router.post("/skills/reload", async (_req, res, next) => {
  try {
    res.json({ items: await buildSkillListItems(await reloadSkills()) });
  } catch (error) {
    next(error);
  }
});

async function buildSkillListItems(skills: Skill[]) {
  const metadataByName = await getSkillMetadataByName();
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    toolCount: skill.tools.length,
    tools: skill.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      parameters: tool.function.parameters
    })),
    enabled: true,
    sourceType: metadataByName.get(skill.name)?.sourceType ?? "system",
    sourcePath: metadataByName.get(skill.name)?.sourcePath ?? null,
    createdAt: metadataByName.get(skill.name)?.createdAt ?? null,
    updatedAt: metadataByName.get(skill.name)?.updatedAt ?? null
  }));
}

router.get("/ilink/bots", async (_req, res, next) => {
  try {
    const bots = await listIlinkBots();
    res.json({ items: bots });
  } catch (error) {
    next(error);
  }
});

router.post("/ilink/qr-sessions", async (req, res, next) => {
  try {
    const payload = z
      .object({
        name: z.string().optional()
      })
      .parse(req.body);
    const session = await createIlinkBotQrSession(payload);
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

router.get("/ilink/qr-sessions/:id", async (req, res, next) => {
  try {
    const session = await getIlinkBotQrSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "QR session not found" });
      return;
    }
    res.json(session);
  } catch (error) {
    next(error);
  }
});

router.post("/ilink/qr-sessions/:id/refresh", async (req, res, next) => {
  try {
    const session = await refreshIlinkQrSession(req.params.id);
    res.json(session);
  } catch (error) {
    next(error);
  }
});

router.post("/ilink/bots/:id/refresh", async (req, res, next) => {
  try {
    const bot = await refreshIlinkLoginStatus(req.params.id);
    res.json(bot);
  } catch (error) {
    next(error);
  }
});

router.post("/ilink/bots/:id/poll", async (req, res, next) => {
  try {
    const bot = await getIlinkBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const result = await pollIlinkUpdates(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete("/ilink/bots/:id", async (req, res, next) => {
  try {
    const result = await deleteIlinkBot(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function normalizeUploadedTemplate(tempPath: string, originalName: string) {
  const safeName = originalName.replace(/[\\/:*?"<>|]/g, "_");
  const targetPath = path.join(templatesDir, `${Date.now()}_${safeName}`);
  await fs.rename(tempPath, targetPath);
  return targetPath;
}

function renderFallbackTemplatePreview() {
  return [
    "<h1>默认工作报告模板</h1>",
    "<table>",
    "<tr><td>项目名称</td><td>{{project_name}}</td></tr>",
    "<tr><td>汇报人</td><td>{{member_name}}</td></tr>",
    "<tr><td>汇报日期</td><td>{{report_date}}</td></tr>",
    "<tr><td>任务名称</td><td>{{task_name}}</td></tr>",
    "<tr><td>完成内容</td><td>{{completed_work}}</td></tr>",
    "<tr><td>存在问题</td><td>{{issues}}</td></tr>",
    "<tr><td>下一步计划</td><td>{{next_plan}}</td></tr>",
    "<tr><td>简短摘要</td><td>{{summary}}</td></tr>",
    "</table>"
  ].join("");
}

function disambiguateFileItems<T extends { fileName: string; kind: string }>(items: T[]) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = item.fileName.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 1) {
      return item;
    }
    return {
      ...item,
      fileName: addFileNameSuffix(item.fileName, count)
    };
  });
}

function addFileNameSuffix(fileName: string, suffix: number) {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${base} (${suffix})${ext}`;
}

function displayWechatUserName(name: string | null | undefined) {
  const value = name?.trim();
  if (!value || value.includes("@im.wechat") || /^微信用户/.test(value) || value === "微信机器人") {
    return "未识别微信名称";
  }
  return value;
}

function displayReportTitle(title: string, userName: string) {
  if (userName === "未识别微信名称") {
    return title.replace(/微信用户[A-Za-z0-9_-]+/g, userName);
  }
  return title.replace(/微信用户[A-Za-z0-9_-]+|微信机器人/g, userName);
}

async function buildFilePreview(input: {
  filePath: string;
  fileName: string;
  publicUrl: string;
  mimeType?: string;
}) {
  const ext = path.extname(input.fileName).toLowerCase();
  const exists = await fs
    .access(input.filePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return {
      type: "missing",
      fileName: input.fileName,
      publicUrl: input.publicUrl,
      message: "文件不存在或已被移除。"
    };
  }

  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext) || input.mimeType?.startsWith("image/")) {
    return {
      type: "image",
      fileName: input.fileName,
      publicUrl: input.publicUrl
    };
  }

  if (ext === ".docx") {
    const result = await mammoth.convertToHtml({ path: input.filePath });
    return {
      type: "html",
      fileName: input.fileName,
      publicUrl: input.publicUrl,
      html: result.value,
      warnings: result.messages.map((message) => message.message)
    };
  }

  if (ext === ".pdf" || input.mimeType === "application/pdf") {
    return {
      type: "pdf",
      fileName: input.fileName,
      publicUrl: input.publicUrl
    };
  }

  if (input.mimeType?.startsWith("video/") || [".mp4", ".mov", ".webm"].includes(ext)) {
    return {
      type: "video",
      fileName: input.fileName,
      publicUrl: input.publicUrl
    };
  }

  if (input.mimeType?.startsWith("audio/") || [".mp3", ".wav", ".m4a", ".ogg"].includes(ext)) {
    return {
      type: "audio",
      fileName: input.fileName,
      publicUrl: input.publicUrl
    };
  }

  if ([".txt", ".md", ".csv", ".json", ".log"].includes(ext) || input.mimeType?.startsWith("text/")) {
    const text = await fs.readFile(input.filePath, "utf8").catch(() => "");
    return {
      type: "text",
      fileName: input.fileName,
      publicUrl: input.publicUrl,
      text: text.slice(0, 120000)
    };
  }

  return {
    type: "file",
    fileName: input.fileName,
    publicUrl: input.publicUrl,
    mimeType: input.mimeType || null
  };
}

function resolveMediaSource(metadata: Record<string, unknown>) {
  if (typeof metadata.source === "string" && metadata.source) {
    return metadata.source;
  }
  return "wechat-media";
}

function toReadableStoragePath(filePath: string) {
  const relative = path.relative(storageRoot, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join("storage", relative).split(path.sep).join("/");
  }
  return filePath;
}

async function trashFileBestEffort(filePath: string) {
  const relative = path.relative(storageRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    console.warn(`Skip trashing file outside storage: ${filePath}`);
    return;
  }
  const trashDir = path.join(storageRoot, ".trash", localDateString());
  const safeName = path.basename(filePath).replace(/[\\/:*?"<>|]/g, "_");
  const targetPath = path.join(trashDir, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safeName}`);
  await fs.mkdir(trashDir, { recursive: true });
  await fs.rename(filePath, targetPath).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    console.warn(`Failed to trash file ${filePath}:`, error);
  });
}

async function getSkillMetadataByName() {
  const skillsDir = path.join(process.cwd(), "src", "skills");
  const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const metadata = new Map<
    string,
    {
      sourceType: "system" | "ai-created";
      sourcePath: string;
      createdAt: string;
      updatedAt: string;
    }
  >();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(skillsDir, entry.name);
    const skillPath = path.join(dir, "SKILL.md");
    const handlerTsPath = path.join(dir, "handler.ts");
    const handlerJsPath = path.join(dir, "handler.js");
    const markdown = await fs.readFile(skillPath, "utf8").catch(() => null);
    if (!markdown) {
      continue;
    }
    const stats = await fs.stat(skillPath);
    const name = parseSkillName(markdown, entry.name);
    const hasTsHandler = await fs
      .access(handlerTsPath)
      .then(() => true)
      .catch(() => false);
    const hasJsHandler = await fs
      .access(handlerJsPath)
      .then(() => true)
      .catch(() => false);
    metadata.set(name, {
      sourceType: hasJsHandler && !hasTsHandler ? "ai-created" : "system",
      sourcePath: path.relative(process.cwd(), dir).split(path.sep).join("/"),
      createdAt: stats.birthtime.toISOString(),
      updatedAt: stats.mtime.toISOString()
    });
  }

  return metadata;
}

function parseSkillName(markdown: string, fallbackName: string) {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter = frontmatterMatch?.[1] || "";
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^name:\s*(.*)$/);
    if (match?.[1]) {
      return match[1].replace(/^["']|["']$/g, "").trim();
    }
  }
  return fallbackName;
}

export { router as adminRoutes };
