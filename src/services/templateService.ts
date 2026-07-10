import type { Template } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const DEFAULT_TEMPLATE_FIELDS = [
  "project_name",
  "member_name",
  "report_date",
  "task_name",
  "completed_work",
  "issues",
  "next_plan",
  "summary",
  "attachments"
];

export async function getActiveTemplate(templateId?: string): Promise<Template> {
  const template = templateId
    ? await prisma.template.findUnique({ where: { id: templateId } })
    : await prisma.template.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: "asc" }
      });

  if (template) {
    return template;
  }

  return prisma.template.create({
    data: {
      name: "默认工作报告模板",
      description: "使用标准字段生成 Word 工作报告",
      fieldsJson: JSON.stringify(DEFAULT_TEMPLATE_FIELDS),
      isActive: true
    }
  });
}
