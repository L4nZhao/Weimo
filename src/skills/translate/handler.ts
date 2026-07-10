import type OpenAI from "openai";
import { z } from "zod";
import { config } from "../../lib/config.js";
import { getSharedOpenAI } from "../../lib/openaiClient.js";
import { withTimeout } from "../../lib/timeout.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

const SAFE_FAILURE_REPLY = "翻译暂时不可用，请稍后再试。";
const EMPTY_TEXT_REPLY = "请告诉我要翻译的内容。";
const DEFAULT_TIMEOUT_MS = 8_000;

const defaultTranslateClient = getSharedOpenAI();

type TranslateClient = Pick<OpenAI, "chat">;

type TranslateDependencies = {
  translateClient: TranslateClient | null | undefined;
  translateModel: string | undefined;
  timeoutMs: number | undefined;
};

const defaultDependencies: TranslateDependencies = {
  translateClient: undefined,
  translateModel: undefined,
  timeoutMs: undefined
};

let dependencies: TranslateDependencies = { ...defaultDependencies };

export function setTranslateDependencies(overrides: Partial<TranslateDependencies>) {
  dependencies = { ...dependencies, ...overrides };
}

export function resetTranslateDependencies() {
  dependencies = { ...defaultDependencies };
}

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "translate_text",
      description: "翻译文本；未指定目标语言时中文译英文，非中文默认译中文。text 为空或指代刚才/上一条时使用最近一条用户消息。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要翻译的原文；可为空以使用最近一条用户消息" },
          target_lang: { type: "string", description: "目标语言，例如 English、Chinese、日语；默认中英互换" }
        },
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  if (toolName !== "translate_text") {
    return { content: `未知工具：${toolName}` };
  }

  const payload = z
    .object({
      text: z.string().optional().default(""),
      target_lang: z.string().optional()
    })
    .parse(args);
  const sourceText = resolveSourceText(payload.text, context);
  if (!sourceText) {
    return { content: EMPTY_TEXT_REPLY };
  }

  const targetLang = payload.target_lang?.trim() || inferTargetLanguage(sourceText);
  const translation = await translateText({
    text: sourceText,
    targetLang
  });
  return { content: translation || SAFE_FAILURE_REPLY };
}

function resolveSourceText(text: string, context: SkillContext) {
  const candidate = stripTranslateCommand(text);
  if (candidate && !isRecentReference(candidate)) {
    return candidate;
  }

  const recentUserMessage = [...(context.recentMessages || [])]
    .reverse()
    .find((item) => item.role === "user" && item.content.trim() && item.content.trim() !== context.userMessage.trim());
  if (recentUserMessage) {
    return recentUserMessage.content.trim();
  }

  const fromCurrent = stripTranslateCommand(context.userMessage);
  return isRecentReference(fromCurrent) ? "" : fromCurrent;
}

function stripTranslateCommand(value: string) {
  const text = value.trim();
  const colonMatch = /(?:翻译|译成|translate|中译英|英译中)[^：:]*[：:]\s*([\s\S]+)$/i.exec(text);
  if (colonMatch?.[1]?.trim()) {
    return colonMatch[1].trim();
  }
  return text
    .replace(/^(?:请|帮我|麻烦(?:你)?|麻烦帮我)?\s*/g, "")
    .replace(/^(?:把|将)?\s*/g, "")
    .replace(/(?:翻译|译成|translate|中译英|英译中)/gi, "")
    .replace(/(?:成|为|到)?(?:英文|英语|中文|汉语|中|英|English|Chinese)$/i, "")
    .trim();
}

function isRecentReference(text: string) {
  return /^(?:我)?(?:刚才|刚刚)?(?:那句|上一条|上条|前一句|上一句)$/.test(text.trim());
}

function inferTargetLanguage(text: string) {
  return /[\p{Script=Han}]/u.test(text) ? "English" : "Chinese";
}

async function translateText(input: { text: string; targetLang: string }) {
  const translateClient = dependencies.translateClient === undefined ? defaultTranslateClient : dependencies.translateClient;
  if (!translateClient) {
    return null;
  }

  try {
    const completion = await withTimeout(
      translateClient.chat.completions.create({
        model: dependencies.translateModel || config.openaiModel,
        messages: [
          {
            role: "system",
            content: [
              "You are a translation engine.",
              "Translate the user's text into the target language.",
              "Output only the translated text. Do not explain, quote, label, or add Markdown."
            ].join("\n")
          },
          {
            role: "user",
            content: [`Target language: ${input.targetLang}`, "Text:", input.text].join("\n")
          }
        ],
        temperature: 0,
        max_tokens: 600
      }),
      dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Translate timed out"
    );
    return completion.choices[0]?.message.content?.trim() || null;
  } catch {
    return null;
  }
}
