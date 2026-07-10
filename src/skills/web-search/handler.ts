import type OpenAI from "openai";
import { z } from "zod";
import { config } from "../../lib/config.js";
import { getSharedOpenAI } from "../../lib/openaiClient.js";
import { withTimeout } from "../../lib/timeout.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 8000;
const UNCONFIGURED_REPLY = "联网搜索还没配置好（需要 TAVILY_API_KEY）";
const SAFE_SEARCH_FAILURE_REPLY = "联网搜索暂时不可用，请稍后再试。";
const EMPTY_SEARCH_REPLY = "这次没有搜到可用结果，可以换个关键词再试。";

const defaultAnswerClient = getSharedOpenAI();

type WebSearchClient = Pick<OpenAI, "chat">;
type FetchLike = typeof fetch;

type SearchResult = {
  title: string;
  url: string;
  content: string;
};

type WebSearchDependencies = {
  tavilyApiKey: string | null | undefined;
  fetchImpl: FetchLike;
  answerClient: WebSearchClient | null | undefined;
  answerModel: string | undefined;
  timeoutMs: number | undefined;
};

const defaultDependencies: WebSearchDependencies = {
  tavilyApiKey: undefined,
  fetchImpl: fetch,
  answerClient: undefined,
  answerModel: undefined,
  timeoutMs: undefined
};

let dependencies: WebSearchDependencies = { ...defaultDependencies };

export function setWebSearchDependencies(overrides: Partial<WebSearchDependencies>) {
  dependencies = { ...dependencies, ...overrides };
}

export function resetWebSearchDependencies() {
  dependencies = { ...defaultDependencies };
}

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "联网搜索公网实时信息和公开资料，并基于搜索结果生成中文短回答。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "用户要联网搜索的问题或关键词" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, _context: SkillContext) {
  if (toolName !== "search_web") {
    return { content: `未知工具：${toolName}` };
  }

  const payload = z
    .object({
      query: z.string().min(1)
    })
    .parse(args);
  const query = payload.query.trim();
  const tavilyApiKey = dependencies.tavilyApiKey === undefined ? config.tavilyApiKey : dependencies.tavilyApiKey;

  if (!tavilyApiKey?.trim()) {
    return { content: UNCONFIGURED_REPLY };
  }

  const results = await searchTavily({
    query,
    tavilyApiKey: tavilyApiKey.trim()
  });
  if (!results) {
    return { content: SAFE_SEARCH_FAILURE_REPLY };
  }
  if (!results.length) {
    return { content: EMPTY_SEARCH_REPLY };
  }

  const answer = await answerFromSearchResults({
    query,
    results
  });
  return {
    content: answer || formatResultsFallback(results)
  };
}

async function searchTavily(input: { query: string; tavilyApiKey: string }): Promise<SearchResult[] | null> {
  try {
    const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const response = await withTimeout(
      dependencies.fetchImpl(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          api_key: input.tavilyApiKey,
          query: input.query,
          max_results: MAX_RESULTS
        }),
        signal: AbortSignal.timeout(timeoutMs)
      }),
      timeoutMs,
      "Web search timed out"
    );

    if (!response.ok) {
      return null;
    }

    const parsed = tavilyResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return null;
    }

    return parsed.data.results
      .map((result) => ({
        title: result.title.trim(),
        url: result.url.trim(),
        content: result.content.trim()
      }))
      .filter((result) => result.title && result.url)
      .slice(0, MAX_RESULTS);
  } catch {
    return null;
  }
}

async function answerFromSearchResults(input: { query: string; results: SearchResult[] }) {
  const answerClient = dependencies.answerClient === undefined ? defaultAnswerClient : dependencies.answerClient;
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
              "你是微信助手的联网搜索总结工具，只能基于给定搜索结果回答。",
              "禁止编造、推测或补充搜索结果之外的信息；结果不足时要直接说明。",
              "用中文给出简短自然的回答，末尾自然附 1-2 个来源标题。",
              "不要输出 Markdown 代码块。"
            ].join("\n")
          },
          {
            role: "user",
            content: [
              `用户问题：${input.query}`,
              "搜索结果：",
              ...input.results.map((result, index) =>
                [`【${index + 1}】${result.title}`, `URL：${result.url}`, `摘要：${result.content}`].join("\n")
              )
            ].join("\n")
          }
        ],
        temperature: 0.2,
        max_tokens: 300
      }),
      dependencies.timeoutMs ?? 2500,
      "Web search timed out"
    );
    const answer = completion.choices[0]?.message.content?.trim();
    return answer ? ensureSourceTitles(answer, input.results) : null;
  } catch {
    return null;
  }
}

function ensureSourceTitles(answer: string, results: SearchResult[]) {
  const sourceTitles = results
    .map((result) => result.title)
    .filter(Boolean)
    .slice(0, 2);
  if (!sourceTitles.length || sourceTitles.some((title) => answer.includes(title))) {
    return answer;
  }
  return `${answer}\n来源：${sourceTitles.join("、")}`;
}

function formatResultsFallback(results: SearchResult[]) {
  return results
    .slice(0, 3)
    .map((result, index) => `${index + 1}. ${result.title}\n要点：${truncate(result.content || "无摘要", 180)}`)
    .join("\n");
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

const tavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().default(""),
        url: z.string().default(""),
        content: z.string().default("")
      })
    )
    .default([])
});
