import { z } from "zod";
import { config } from "../lib/config.js";
import { localDateString } from "../lib/dates.js";
import { getSharedOpenAI } from "../lib/openaiClient.js";

export const extractedReportSchema = z.object({
  project_name: z.string().min(1),
  member_name: z.string().min(1),
  report_date: z.string().min(1),
  task_name: z.string().min(1),
  completed_work: z.string().min(1),
  issues: z.string().min(1),
  next_plan: z.string().min(1),
  summary: z.string().min(1),
  attachments: z.array(z.string()).default([])
});

export type ExtractedReportFields = z.infer<typeof extractedReportSchema>;

const client = getSharedOpenAI();

export async function extractReportFields(input: {
  rawText: string;
  memberName: string;
  projectName?: string | null;
}): Promise<ExtractedReportFields> {
  if (!client) {
    return fallbackExtract(input);
  }

  try {
    const today = localDateString();
    const completion = await client.chat.completions.create({
      model: config.openaiModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            [
              "你是微信里的企业工作报告助理，负责把成员随手发送的工作进展整理成正式报告字段。",
              "只输出 JSON，不要输出 Markdown，不要解释。",
              "字段固定为 project_name, member_name, report_date, task_name, completed_work, issues, next_plan, summary, attachments。",
              "attachments 必须是字符串数组。",
              "如果原文没有提到项目名，使用传入的 project_name。",
              "如果原文没有提到汇报人，使用传入的 member_name。",
              "如果原文没有提到日期，使用 today。",
              "completed_work 要整理成清楚的工作成果描述，不要机械复制原文。",
              "issues 只写真实问题、风险、阻塞；没有就写“暂无明显问题”。",
              "next_plan 要识别“明天、后续、计划、下一步”等内容；没有就写“待补充”。",
              "summary 用一句自然、专业的话总结本次汇报。"
            ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            today,
            member_name: input.memberName,
            project_name: input.projectName || "默认项目",
            raw_text: input.rawText
          })
        }
      ]
    });

    const content = completion.choices[0]?.message.content ?? "{}";
    const parsed = extractedReportSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      return fallbackExtract(input);
    }

    return parsed.data;
  } catch (error) {
    console.error("AI report extraction failed", error);
    return fallbackExtract(input);
  }
}

export function fallbackExtract(input: {
  rawText: string;
  memberName: string;
  projectName?: string | null;
}): ExtractedReportFields {
  const text = input.rawText.trim();
  const tomorrow = matchAfter(text, /(明天|下周|下一步|后续|计划)(.*)$/);
  const taskName = inferTaskName(text);

  return {
    project_name: input.projectName || "默认项目",
    member_name: input.memberName,
    report_date: localDateString(),
    task_name: taskName,
    completed_work: text || "未提及",
    issues: extractIssueSentences(text),
    next_plan: tomorrow || "待补充",
    summary: summarize(text),
    attachments: []
  };
}

function inferTaskName(text: string) {
  const match = text.match(/(?:完成了?|开发了?|修复了?|实现了?)([^，。,.;；]{2,24})/);
  return match?.[1]?.trim() || text.slice(0, 24) || "工作汇报";
}

function matchAfter(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[0]?.trim();
}

function extractIssueSentences(text: string) {
  const sentences = text.match(/[^。；;.!？?]+[。；;.!？?]?/g) || [];
  const issues = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => /(问题|风险|阻塞|困难)/.test(sentence))
    .join(" ");
  return issues ? issues.slice(0, 120) : "暂无明显问题";
}

function summarize(text: string) {
  if (!text) {
    return "提交了一份工作汇报。";
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
