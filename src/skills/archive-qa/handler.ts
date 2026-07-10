import type OpenAI from "openai";
import { z } from "zod";
import { config } from "../../lib/config.js";
import { getSharedOpenAI } from "../../lib/openaiClient.js";
import { withTimeout } from "../../lib/timeout.js";
import { parseMetadata, searchMediaByText } from "../../services/mediaService.js";
import { searchMemories } from "../../services/memoryService.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

const TOP_N = 5;
const SAFE_FAILURE_REPLY = "归档里暂时没法生成可靠回答，请稍后再试，或换关键词、发原文件让我重新识别。";
const EMPTY_ARCHIVE_REPLY = "归档里没查到相关内容。可以换个关键词再问，或把原文件发给我。";

const defaultArchiveQaClient = getSharedOpenAI();

type ArchiveQaClient = Pick<OpenAI, "chat">;
type MediaHit = Awaited<ReturnType<typeof searchMediaByText>>[number];
type MemoryHit = Awaited<ReturnType<typeof searchMemories>>[number];

type ArchiveQaDependencies = {
  answerClient: ArchiveQaClient | null | undefined;
  answerModel: string | undefined;
  timeoutMs: number | undefined;
  searchMedia: typeof searchMediaByText;
  searchMemoryEntries: typeof searchMemories;
};

const defaultDependencies: ArchiveQaDependencies = {
  answerClient: undefined,
  answerModel: undefined,
  timeoutMs: undefined,
  searchMedia: searchMediaByText,
  searchMemoryEntries: searchMemories
};

let dependencies: ArchiveQaDependencies = { ...defaultDependencies };

export function setArchiveQaDependencies(overrides: Partial<ArchiveQaDependencies>) {
  dependencies = { ...dependencies, ...overrides };
}

export function resetArchiveQaDependencies() {
  dependencies = { ...defaultDependencies };
}

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "ask_archive",
      description: "基于用户归档的媒体描述、长期记忆和知识库条目回答信息问题，不发送文件本身。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "用户关于归档内容的原始问题" }
        },
        required: ["question"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  if (toolName !== "ask_archive") {
    return { content: `未知工具：${toolName}` };
  }

  const payload = z
    .object({
      question: z.string().min(1)
    })
    .parse(args);
  const question = payload.question.trim();

  const contextItems = await retrieveArchiveContext({
    wechatUserId: context.wechatUserId,
    question
  });
  if (!contextItems.length) {
    return { content: EMPTY_ARCHIVE_REPLY };
  }

  const answer = await answerFromArchiveContext({
    question,
    contextItems
  });
  return { content: answer || SAFE_FAILURE_REPLY };
}

async function retrieveArchiveContext(input: { wechatUserId: string; question: string }) {
  const [mediaItems, memoryItems, knowledgeItems] = await Promise.all([
    dependencies.searchMedia({
      wechatUserId: input.wechatUserId,
      query: input.question,
      limit: TOP_N
    }),
    dependencies.searchMemoryEntries({
      wechatUserId: input.wechatUserId,
      query: input.question,
      limit: TOP_N * 2
    }),
    dependencies.searchMemoryEntries({
      wechatUserId: input.wechatUserId,
      query: input.question,
      category: "knowledge",
      limit: TOP_N
    })
  ]);

  return [
    ...mediaItems.slice(0, TOP_N).map(formatMediaContext),
    ...memoryItems
      .filter((item) => item.category !== "knowledge")
      .slice(0, TOP_N)
      .map(formatMemoryContext),
    ...knowledgeItems.slice(0, TOP_N).map(formatKnowledgeContext)
  ].filter(Boolean);
}

function formatMediaContext(item: MediaHit) {
  const metadata = parseMetadata(item.metadataJson);
  const fullCaption = typeof metadata.fullCaption === "string" ? metadata.fullCaption : "";
  const userNotes = Array.isArray(metadata.userNotes)
    ? metadata.userNotes.filter((note): note is string => typeof note === "string" && Boolean(note.trim())).join("；")
    : "";
  const details = [item.caption, fullCaption, userNotes].filter(Boolean).join("\n");
  return [
    "来源：媒体描述",
    `文件名：${item.fileName}`,
    `媒体类型：${item.mediaType}`,
    details ? `内容：${details}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMemoryContext(item: MemoryHit) {
  return ["来源：记忆", `分类：${item.category}`, `内容：${item.content}`].join("\n");
}

function formatKnowledgeContext(item: MemoryHit) {
  return ["来源：知识库", `内容：${item.content}`].join("\n");
}

async function answerFromArchiveContext(input: { question: string; contextItems: string[] }) {
  const answerClient = dependencies.answerClient === undefined ? defaultArchiveQaClient : dependencies.answerClient;
  if (!answerClient) {
    return null;
  }

  try {
    const completion = await withTimeout(
      answerClient.chat.completions.create({
        model: dependencies.answerModel || config.openaiModel,
        messages: [
          {
            role: "system",
            content: [
              "你是微信助手的归档问答工具，只能基于给定归档条目回答用户问题。",
              "条目不足以回答时，必须如实说“归档里没查到”，并建议用户换关键词或发原文件。",
              "涉及具体文件时，在答案里自然提及文件名。",
              "禁止编造、推测、补充条目之外的信息；数字、日期、编号和文件名必须原样保留。",
              "回答保持简洁自然，不要输出 Markdown 代码块。"
            ].join("\n")
          },
          {
            role: "user",
            content: [
              `用户问题：${input.question}`,
              "归档条目：",
              ...input.contextItems.map((item, index) => `【${index + 1}】\n${item}`)
            ].join("\n")
          }
        ],
        temperature: 0.2,
        max_tokens: 260
      }),
      dependencies.timeoutMs ?? 2500,
      "Archive QA timed out"
    );
    return completion.choices[0]?.message.content?.trim() || null;
  } catch {
    return null;
  }
}
