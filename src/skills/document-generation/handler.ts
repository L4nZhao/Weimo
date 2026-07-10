import { z } from "zod";
import { config } from "../../lib/config.js";
import { getSharedOpenAI } from "../../lib/openaiClient.js";
import { generateDocumentFile } from "../../services/documentService.js";
import type { OutgoingMedia, SkillContext, ToolDef } from "../../services/skillTypes.js";

const client = getSharedOpenAI();

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "generate_word_document",
      description: "根据用户需求生成通用 .docx Word 文档，保存到媒体库，并触发微信直接发送。",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "文档标题，例如 人工智能发展深度报告（2024-2025）"
          },
          prompt: {
            type: "string",
            description: "用户原始写作需求"
          },
          content: {
            type: "string",
            description: "可选正文。如果未提供，工具会根据 prompt 自动生成正文。"
          }
        },
        required: ["title", "prompt"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  if (toolName !== "generate_word_document") {
    return { content: `未知工具：${toolName}` };
  }

  const payload = z
    .object({
      title: z.string().min(1),
      prompt: z.string().min(1),
      content: z.string().optional()
    })
    .parse(args);

  const content = payload.content?.trim() || (await generateContent(payload.title, payload.prompt));
  const media = await generateDocumentFile({
    wechatUserId: context.wechatUserId,
    userId: context.userId,
    memberName: context.memberName,
    title: payload.title,
    prompt: payload.prompt,
    content
  });

  context.recentFile = {
    id: media.id,
    title: payload.title,
    fileName: media.fileName,
    filePath: media.filePath,
    publicUrl: media.publicUrl,
    mediaType: "file",
    source: "generated-document"
  };

  const outgoingMedia: OutgoingMedia[] = [
    {
      mediaType: "file",
      fileName: media.fileName,
      filePath: media.filePath,
      publicUrl: media.publicUrl,
      delivery: "direct",
      source: "generated-document"
    }
  ];

  return {
    content: "Word 文档已生成，正在发送……",
    sideEffects: {
      outgoingMedia
    }
  };
}

async function generateContent(title: string, prompt: string) {
  if (!client) {
    return `${title}\n\n${prompt}`;
  }

  const completion = await client.chat.completions.create({
    model: config.openaiModel,
    messages: [
      {
        role: "system",
        content: [
          "你是严谨的中文 Word 文档写作助手。",
          "输出纯文本正文，不要输出 Markdown，不要使用代码块。",
          "结构清晰，段落之间用空行分隔。",
          "如果用户要求文章、报告或方案，要给出完整正文，而不是说明你会生成。"
        ].join("\n")
      },
      {
        role: "user",
        content: `标题：${title}\n\n写作要求：${prompt}`
      }
    ],
    temperature: 0.5
  });

  return completion.choices[0]?.message.content?.trim() || `${title}\n\n${prompt}`;
}
