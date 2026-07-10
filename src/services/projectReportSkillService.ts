import crypto from "node:crypto";
import { config } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { toSignedStorageUrl } from "../lib/paths.js";
import { extractReportFields, type ExtractedReportFields } from "./aiExtractor.js";
import { buildReportEmbeddingText, embedText } from "./embeddingService.js";
import { getActiveTemplate } from "./templateService.js";
import { generateReportDocx } from "./wordService.js";

export async function generateProjectReport(input: {
  userId: string;
  memberName: string;
  rawText: string;
  templateId?: string;
}) {
  const rawText = input.rawText.trim();
  if (!rawText) {
    throw new Error("汇报内容不能为空。");
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    include: { project: true }
  });
  if (!user) {
    throw new Error("用户不存在。");
  }

  const template = await getActiveTemplate(input.templateId);
  const reporterName = resolveReporterName(input.memberName, user.name);
  const fields = normalizeReportFields(await extractReportFields({
    rawText,
    memberName: reporterName,
    projectName: user.project?.name
  }), reporterName);
  const reportId = `report_${crypto.randomUUID()}`;
  const title = await buildUniqueReportTitle({
    userId: user.id,
    baseTitle: await resolveBaseReportTitle({
      userId: user.id,
      rawText,
      fields
    })
  });
  const keywords = buildReportKeywords(fields);
  const wordFilePath = await generateReportDocx({
    reportId,
    title,
    fields,
    rawText,
    templateFilePath: template.templateFilePath
  });
  const embedding = await embedText(
    buildReportEmbeddingText({
      title,
      rawText,
      fields,
      memberName: reporterName,
      projectName: user.project?.name
    })
  );

  const report = await prisma.report.create({
    data: {
      id: reportId,
      userId: user.id,
      projectId: user.projectId,
      templateId: template.id,
      title,
      rawText,
      extractedFieldsJson: JSON.stringify(fields),
      summary: fields.summary,
      keywords,
      embeddingJson: embedding ? JSON.stringify(embedding.embedding) : undefined,
      embeddingModel: embedding?.model,
      wordFilePath,
      status: "generated"
    }
  });

  return {
    report,
    fields,
    downloadUrl: toSignedStorageUrl(wordFilePath, config.publicBaseUrl)
  };
}

function normalizeReportFields(fields: ExtractedReportFields, memberName: string) {
  return {
    ...fields,
    member_name: memberName
  };
}

function resolveReporterName(memberName: string | undefined, storedName: string | null | undefined) {
  const inputName = normalizeUsableWechatName(memberName);
  if (inputName) {
    return inputName;
  }

  const userName = normalizeUsableWechatName(storedName);
  if (userName) {
    return userName;
  }

  return "未识别微信名称";
}

function normalizeUsableWechatName(name: string | null | undefined) {
  const value = name?.trim();
  if (!value || isFallbackWechatName(value)) {
    return undefined;
  }
  return value;
}

function isFallbackWechatName(value: string) {
  return (
    value === "微信机器人" ||
    value === "未绑定成员" ||
    value === "未识别微信名称" ||
    value.includes("@im.wechat") ||
    /^微信用户/.test(value)
  );
}

async function resolveBaseReportTitle(input: {
  userId: string;
  rawText: string;
  fields: ExtractedReportFields;
}) {
  const previous = await prisma.report.findFirst({
    where: {
      userId: input.userId,
      rawText: input.rawText
    },
    orderBy: { createdAt: "desc" },
    select: { title: true }
  });
  return stripReportTitleSuffix(previous?.title) || buildReportTitle(input.fields);
}

function stripReportTitleSuffix(title: string | undefined) {
  return title?.replace(/\s+\(\d+\)$/, "");
}

export async function buildUniqueReportTitle(input: { userId: string; baseTitle: string }) {
  const baseTitle = input.baseTitle;
  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const candidate = suffix === 1 ? baseTitle : `${baseTitle} (${suffix})`;
    const existing = await prisma.report.findFirst({
      where: { userId: input.userId, title: candidate },
      select: { id: true }
    });
    if (!existing) {
      return candidate;
    }
  }
  return `${baseTitle} (${timeSuffix(new Date())})`;
}

function buildReportTitle(fields: ExtractedReportFields) {
  return `${fields.report_date} ${fields.member_name} ${fields.task_name}`;
}

function buildReportKeywords(fields: ExtractedReportFields) {
  return [
    fields.project_name,
    fields.member_name,
    fields.report_date,
    fields.task_name,
    fields.completed_work,
    fields.issues,
    fields.next_plan,
    fields.summary,
    ...fields.attachments
  ]
    .filter(Boolean)
    .join(" ");
}

function timeSuffix(date: Date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}${minutes}${seconds}`;
}
