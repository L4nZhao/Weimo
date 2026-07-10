import { z } from "zod";
import { generateProjectReport } from "../../services/projectReportSkillService.js";
import type { OutgoingMedia } from "../../services/skillTypes.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "generate_project_report",
      description: "理解用户的项目/工作汇报文本，直接生成并存储 .docx Word 报告，然后触发微信直发。",
      parameters: {
        type: "object",
        properties: {
          rawText: {
            type: "string",
            description: "用户原始汇报内容"
          },
          templateId: {
            type: "string",
            description: "可选模板 ID；不传则使用模板管理中的当前启用模板"
          }
        },
        required: ["rawText"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  if (toolName === "generate_project_report") {
    const payload = z
      .object({
        rawText: z.string().min(1),
        templateId: z.string().optional()
      })
      .parse(args);
    const result = await generateProjectReport({
      userId: context.userId,
      memberName: context.memberName,
      rawText: payload.rawText,
      templateId: payload.templateId
    });
    context.recentReport = {
      id: result.report.id,
      title: result.report.title,
      filePath: result.report.wordFilePath,
      publicUrl: result.downloadUrl
    };
    const outgoingMedia: OutgoingMedia[] = [
      {
        mediaType: "file",
        fileName: `${result.report.title}.docx`,
        filePath: result.report.wordFilePath,
        publicUrl: result.downloadUrl,
        delivery: "direct",
        source: "generated-report"
      }
    ];
    return {
      content: "已生成项目汇报 Word 报告，正在发送……",
      sideEffects: {
        outgoingMedia
      }
    };
  }

  return { content: `未知工具：${toolName}` };
}
