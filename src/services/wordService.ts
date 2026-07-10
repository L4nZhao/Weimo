import fs from "node:fs/promises";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { reportsDir } from "../lib/paths.js";
import type { ExtractedReportFields } from "./aiExtractor.js";

export async function generateReportDocx(input: {
  reportId: string;
  title: string;
  fields: ExtractedReportFields;
  rawText: string;
  templateFilePath?: string | null;
}) {
  await fs.mkdir(reportsDir, { recursive: true });
  const safeTitle = input.title.replace(/[\\/:*?"<>|]/g, "_");
  const fileName = `${safeTitle}_${input.reportId}.docx`;
  const outputPath = path.join(reportsDir, fileName);

  if (input.templateFilePath) {
    const buffer = await renderTemplate(input.templateFilePath, input.fields);
    await fs.writeFile(outputPath, buffer);
  } else {
    const buffer = await renderFallbackDocx(input.title, input.fields, input.rawText);
    await fs.writeFile(outputPath, buffer);
  }

  return outputPath;
}

async function renderTemplate(templateFilePath: string, fields: ExtractedReportFields) {
  const content = await fs.readFile(templateFilePath, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" }
  });

  doc.render(fields);
  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE"
  });
}

async function renderFallbackDocx(title: string, fields: ExtractedReportFields, rawText: string) {
  const rows = [
    ["项目名称", fields.project_name],
    ["汇报人", fields.member_name],
    ["汇报日期", fields.report_date],
    ["任务名称", fields.task_name],
    ["完成内容", fields.completed_work],
    ["存在问题", fields.issues],
    ["下一步计划", fields.next_plan],
    ["简短摘要", fields.summary],
    ["附件预留", fields.attachments.length ? fields.attachments.join("\n") : "未上传"]
  ];

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: title,
            heading: HeadingLevel.HEADING_1
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map(
              ([label, value]) =>
                new TableRow({
                  children: [
                    new TableCell({
                      width: { size: 24, type: WidthType.PERCENTAGE },
                      children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })]
                    }),
                    new TableCell({
                      width: { size: 76, type: WidthType.PERCENTAGE },
                      children: [new Paragraph(value)]
                    })
                  ]
                })
            )
          }),
          new Paragraph(""),
          new Paragraph({ children: [new TextRun({ text: "原始汇报", bold: true })] }),
          new Paragraph(rawText)
        ]
      }
    ]
  });

  return Packer.toBuffer(doc);
}
