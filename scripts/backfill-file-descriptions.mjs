import { prisma } from "../dist/src/lib/prisma.js";
import { summarizeFileDescription } from "../dist/src/services/fileDescriptionService.js";

function parseMetadata(value) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function backfillMediaFiles() {
  const items = await prisma.mediaFile.findMany({ orderBy: { createdAt: "desc" } });
  let updated = 0;

  for (const item of items) {
    const metadata = parseMetadata(item.metadataJson);
    const previousCaption = item.caption || "";
    if (previousCaption && previousCaption.length > 140 && !metadata.fullCaption) {
      metadata.fullCaption = previousCaption;
    }
    const caption = summarizeFileDescription({
      fileName: item.fileName,
      mediaType: item.mediaType,
      text: previousCaption,
      metadata
    });
    const metadataJson = Object.keys(metadata).length ? JSON.stringify(metadata) : null;
    if (caption !== item.caption || metadataJson !== item.metadataJson) {
      await prisma.mediaFile.update({
        where: { id: item.id },
        data: {
          caption,
          metadataJson
        }
      });
      updated += 1;
    }
  }

  return { total: items.length, updated };
}

async function backfillReports() {
  const reports = await prisma.report.findMany({
    include: { project: true, template: true },
    orderBy: { createdAt: "desc" }
  });
  let updated = 0;

  for (const report of reports) {
    const summary = summarizeFileDescription({
      fileName: `${report.title}.docx`,
      mediaType: "file",
      text: report.summary || report.rawText,
      metadata: {
        title: report.title,
        projectName: report.project?.name,
        templateName: report.template?.name,
        keywords: report.keywords
      }
    });
    if (summary !== report.summary) {
      await prisma.report.update({
        where: { id: report.id },
        data: { summary }
      });
      updated += 1;
    }
  }

  return { total: reports.length, updated };
}

try {
  const [media, reports] = await Promise.all([backfillMediaFiles(), backfillReports()]);
  console.log(JSON.stringify({ ok: true, media, reports }, null, 2));
} finally {
  await prisma.$disconnect();
}
