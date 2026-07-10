import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { embedText } from "./embeddingService.js";
import { summarizeFileDescription } from "./fileDescriptionService.js";
import { createMediaRecord, persistMedia } from "./mediaService.js";
import { prisma } from "../lib/prisma.js";

export async function generateDocumentFile(input: {
  wechatUserId: string;
  userId: string;
  memberName: string;
  title: string;
  content: string;
  prompt: string;
}) {
  const title = sanitizeTitle(input.title || "Word 文档");
  const content = input.content.trim();
  if (!content) {
    throw new Error("文档内容不能为空。");
  }

  const buffer = await renderDocx(title, content);
  const persisted = await persistMedia({
    bytes: buffer,
    mediaType: "file",
    fileName: `${title}.docx`
  });
  const indexText = [title, input.prompt, content].filter(Boolean).join("\n");
  const caption = summarizeFileDescription({
    fileName: `${title}.docx`,
    mediaType: "file",
    text: content,
    metadata: {
      title,
      prompt: input.prompt
    }
  });
  const embedding = await embedText(indexText);
  const media = await createMediaRecord({
    wechatUserId: input.wechatUserId,
    memberName: input.memberName,
    mediaType: "file",
    fileName: `${title}.docx`,
    filePath: persisted.filePath,
    publicUrl: persisted.publicUrl,
    mimeType: persisted.mimeType,
    fileSize: persisted.fileSize,
    caption,
    metadata: {
      source: "generated-document",
      title,
      prompt: input.prompt,
      summary: caption
    }
  });

  return prisma.mediaFile.update({
    where: { id: media.id },
    data: {
      embeddingJson: embedding ? JSON.stringify(embedding.embedding) : undefined,
      embeddingModel: embedding?.model
    }
  });
}

async function renderDocx(title: string, content: string) {
  const children = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1
    }),
    ...content
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        if (/^[一二三四五六七八九十]+[、.．]|^\d+[、.．]/.test(block) && block.length < 80) {
          return new Paragraph({
            text: block,
            heading: HeadingLevel.HEADING_2
          });
        }
        return new Paragraph({
          children: [new TextRun(block)]
        });
      })
  ];

  const doc = new Document({
    sections: [{ children }]
  });
  return Packer.toBuffer(doc);
}

function sanitizeTitle(title: string) {
  return title
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Word 文档";
}
