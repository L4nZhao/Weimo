import type OpenAI from "openai";
import { config } from "../lib/config.js";
import { getSharedOpenAI } from "../lib/openaiClient.js";
import { withTimeout } from "../lib/timeout.js";
import type { Skill } from "./skillTypes.js";

export type RequestLayer = "skill" | "knowledge" | "memory" | "conversation";

export type RequestKind =
  | "skill-governance"
  | "assistant-help"
  | "project-report"
  | "document-generation"
  | "media-search"
  | "archive-qa"
  | "web-search"
  | "translate"
  | "weather"
  | "reminder"
  | "todo"
  | "memory-store"
  | "memory-query"
  | "knowledge-store"
  | "knowledge-query"
  | "general-chat";

export type RequestPlan = {
  layer: RequestLayer;
  kind: RequestKind;
  reason: string;
  allowSkillPlanner: boolean;
  allowMediaPrecheck: boolean;
  preferredSkills: string[];
};

export type RouterOptions = {
  routerClient?: Pick<OpenAI, "chat"> | null;
  routerModel?: string;
  timeoutMs?: number;
  logger?: Pick<Console, "info"> | null;
};

const defaultRouterClient = getSharedOpenAI();

const requestKinds = new Set<RequestKind>([
  "skill-governance",
  "assistant-help",
  "project-report",
  "document-generation",
  "media-search",
  "archive-qa",
  "web-search",
  "translate",
  "weather",
  "reminder",
  "todo",
  "memory-store",
  "memory-query",
  "knowledge-store",
  "knowledge-query",
  "general-chat"
]);

const routerSystemPrompt = [
  "你是微信助手的请求意图路由器。只判断用户消息属于哪个 RequestKind。",
  "只输出 JSON，不要输出 Markdown。格式必须是：{\"kind\":\"...\"}。",
  "可选 kind 及说明：",
  "skill-governance: 用户明确要求创建、更新、沉淀 skill/技能/工作流。例：帮我创建一个日报技能 / 把这个流程沉淀成工作流",
  "assistant-help: 用户询问助手能做什么、会什么、怎么用、使用说明或帮助。例：你能干什么 / 你会什么 / help",
  "project-report: 用户正在提交或纠正工作、项目、日报、周报、月报内容。例：今天工作汇报如下 / 刚才那段是项目汇报",
  "document-generation: 用户要求生成报告、文章、文档、材料、方案、总结等文件内容。例：帮我写一份介绍文档 / 生成一个复盘总结给我",
  "media-search: 用户要历史图片、照片、截图、文件、报告、文档、PDF、语音或视频本身，想找、发送、打开或展示。例：找一下东方明珠图片 / 把刚刚的报告发我",
  "archive-qa: 用户问归档内容里的信息、事实、数字、日期、有效期、是哪一个或什么时候，而不是要文件本身。例：我发过的保修文件保修多久 / 档案里合同到什么时候",
  "web-search: 用户要查询公网实时信息或公开资料，例如新闻、汇率、百科、赛况；不用于用户自己的归档、媒体文件、记忆或知识库。",
  "translate: 用户要求翻译文本、中译英、英译中、译成某种语言，或翻译上一条/刚才那句。",
  "weather: 用户询问天气、气温、温度、降雨、下雨、风力或 weather。例：上海今天会下雨吗 / 明天气温多少",
  "reminder: 用户要设置、查看、取消或推迟提醒/日程提醒。例：明天下午3点提醒我开会 / 我有哪些提醒 / 取消开会提醒",
  "todo: 用户要添加、查看、完成或清理待办清单。例：记个待办 买机票 / 我有哪些待办 / 做完那个待办了",
  "memory-store: 用户要求记住个人偏好、习惯或默认格式。例：记住我喜欢简洁风格 / 以后默认用中文",
  "memory-query: 用户询问偏好、记忆或历史上下文。例：你记得我的偏好吗 / 我之前保存过什么",
  "knowledge-store: 用户要求保存资料、案例或素材到知识库。例：把这段资料存入知识库 / 记录到案例库",
  "knowledge-query: 用户要求查询知识库、资料库、案例库、素材库或知识资料。例：查一下知识库里的案例 / 搜索资料库的模板",
  "general-chat: 普通闲聊、问答、解释、写作讨论，且不属于以上类型。例：你好 / 解释一下这个概念"
].join("\n");

export async function classifyRequest(message: string, options: RouterOptions = {}): Promise<RequestPlan> {
  const text = message.trim();
  const fastPathKind = classifyRegexFastPath(text);
  if (fastPathKind) {
    return buildRequestPlan(fastPathKind, text);
  }

  return classifyResidualRequest(text, options);
}

export function selectRuntimeSkills(skills: Skill[], plan: RequestPlan, selectedSkillName?: string) {
  const allowed = new Set(plan.preferredSkills);
  if (selectedSkillName) {
    allowed.add(selectedSkillName);
  }

  return skills.filter((skill) => {
    if (skill.name === "create-skill") {
      return plan.kind === "skill-governance";
    }
    return allowed.has(skill.name);
  });
}

function classifyRegexFastPath(text: string): RequestKind | null {
  if (isSkillGovernanceIntent(text)) {
    return "skill-governance";
  }
  if (isAssistantHelpIntent(text)) {
    return "assistant-help";
  }
  if (isWeatherIntent(text)) {
    return "weather";
  }
  if (isReminderIntent(text)) {
    return "reminder";
  }
  if (isProjectReportIntent(text)) {
    return "project-report";
  }
  if (isTodoIntent(text)) {
    return "todo";
  }
  if (isTranslateIntent(text)) {
    return "translate";
  }
  if (isDocumentGenerationIntent(text)) {
    return "document-generation";
  }
  if (isArchiveQaIntent(text)) {
    return "archive-qa";
  }
  if (isKnowledgeStoreIntent(text)) {
    return "knowledge-store";
  }
  if (isMemoryStoreIntent(text)) {
    return "memory-store";
  }
  if (isKnowledgeQueryIntent(text)) {
    return "knowledge-query";
  }
  if (isMemoryQueryIntent(text)) {
    return "memory-query";
  }
  if (isWebSearchIntent(text)) {
    return "web-search";
  }
  if (isMediaIntent(text)) {
    return "media-search";
  }
  return null;
}

function buildRequestPlan(kind: RequestKind, text: string): RequestPlan {
  switch (kind) {
    case "skill-governance":
      return {
        layer: "skill",
        kind,
        reason: "用户明确要求创建、更新或沉淀 Skill 工作流。",
        allowSkillPlanner: true,
        allowMediaPrecheck: false,
        preferredSkills: ["create-skill", "knowledge"]
      };
    case "assistant-help":
      return {
        layer: "skill",
        kind,
        reason: "用户询问助手能力目录，应由 assistant-help Skill 动态列出当前能力。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["assistant-help"]
      };
    case "weather":
      return {
        layer: "skill",
        kind,
        reason: "天气查询由 weather-query Skill 直接处理。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["weather-query"]
      };
    case "reminder":
      return {
        layer: "skill",
        kind,
        reason: "提醒/日程提醒由 reminder Skill 直接处理。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["reminder"]
      };
    case "todo":
      return {
        layer: "skill",
        kind,
        reason: "待办清单由 todo Skill 直接处理。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["todo"]
      };
    case "translate":
      return {
        layer: "skill",
        kind,
        reason: "翻译请求由 translate Skill 直接处理。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["translate"]
      };
    case "project-report":
      return {
        layer: "skill",
        kind,
        reason: "用户正在提交或纠正工作/项目汇报内容，应由 project-report Skill 处理。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["project-report", "knowledge"]
      };
    case "document-generation":
      return {
        layer: "skill",
        kind,
        reason: "文档生成由 document-generation Skill 直接处理。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["document-generation", "knowledge"]
      };
    case "knowledge-store":
      return {
        layer: "knowledge",
        kind,
        reason: "用户要求保存资料到知识库。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["knowledge"]
      };
    case "memory-store":
      return {
        layer: "memory",
        kind,
        reason: "用户表达偏好或要求记住个人习惯。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["knowledge"]
      };
    case "media-search":
      return {
        layer: "skill",
        kind,
        reason: "媒体和文件查找由 media-search Skill 处理。",
        allowSkillPlanner: false,
        allowMediaPrecheck: true,
        preferredSkills: ["media-search", "knowledge"]
      };
    case "archive-qa":
      return {
        layer: "skill",
        kind,
        reason: "用户询问归档内容里的信息，应由 archive-qa Skill 基于归档上下文回答。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["archive-qa", "media-search"]
      };
    case "web-search":
      return {
        layer: "skill",
        kind,
        reason: "用户要求查询公网实时信息或公开资料，应由 web-search Skill 联网搜索回答。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["web-search", "knowledge"]
      };
    case "knowledge-query":
      return {
        layer: "knowledge",
        kind,
        reason: "用户要求查询知识库内容。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["knowledge"]
      };
    case "memory-query":
      return {
        layer: "memory",
        kind,
        reason: "用户询问偏好、记忆或历史上下文。",
        allowSkillPlanner: false,
        allowMediaPrecheck: false,
        preferredSkills: ["knowledge"]
      };
    case "general-chat": {
      const allowMediaPrecheck = shouldRunAmbiguousMediaPrecheck(text);
      return {
        layer: "conversation",
        kind,
        reason: "普通对话，默认不创建 Skill。",
        allowSkillPlanner: false,
        allowMediaPrecheck,
        preferredSkills: allowMediaPrecheck ? ["knowledge", "media-search"] : ["knowledge"]
      };
    }
  }
}

async function classifyResidualRequest(text: string, options: RouterOptions) {
  const startedAt = Date.now();
  let selectedKind: RequestKind = "general-chat";
  const routerClient = options.routerClient === undefined ? defaultRouterClient : options.routerClient;
  const logger = options.logger === undefined ? console : options.logger;

  try {
    if (routerClient) {
      const completion = await withTimeout(
        routerClient.chat.completions.create({
          model: options.routerModel || process.env.ROUTER_MODEL || config.openaiModel,
          messages: [
            { role: "system", content: routerSystemPrompt },
            { role: "user", content: text }
          ],
          temperature: 0,
          max_tokens: 40,
          response_format: { type: "json_object" }
        }),
        options.timeoutMs ?? 2500,
        "LLM router timed out"
      );
      const parsedKind = parseRouterKind(completion.choices[0]?.message.content || "");
      if (parsedKind) {
        selectedKind = parsedKind;
      }
    }
  } catch {
    selectedKind = "general-chat";
  }

  const elapsedMs = Date.now() - startedAt;
  logger?.info(`[planner-router] ${text.slice(0, 30)} -> ${selectedKind} (${elapsedMs}ms)`);
  return buildRequestPlan(selectedKind, text);
}

function parseRouterKind(content: string): RequestKind | null {
  try {
    const parsed = JSON.parse(content) as { kind?: unknown };
    return typeof parsed.kind === "string" && requestKinds.has(parsed.kind as RequestKind)
      ? (parsed.kind as RequestKind)
      : null;
  } catch {
    console.warn(`[planner-router] failed to parse route JSON: ${content.slice(0, 30)}`);
    return null;
  }
}
function isSkillGovernanceIntent(text: string) {
  return /(创建|新增|生成|做|更新|修改|沉淀|保存).{0,12}(skill|Skill|技能|工作流|流程能力)/i.test(text);
}

function isAssistantHelpIntent(text: string) {
  return /你能干什么|你会什么|怎么用|使用说明|^(?:帮助|help)$/i.test(text);
}

export function isWeatherIntent(text: string) {
  return /(天气|气温|温度|降雨|下雨|风力|weather|temperature)/i.test(text);
}

export function isReminderIntent(text: string) {
  return /(提醒我|定个提醒|设个提醒|取消.{0,6}提醒|我有哪些提醒|推迟.{0,8}(分钟|小时))/.test(text);
}

export function isProjectReportIntent(text: string) {
  return /(工作汇报|项目汇报|日报|周报|月报|汇报工作|工作报告|汇报工作内容)/.test(text);
}

export function isTodoIntent(text: string) {
  return (
    /(待办|记个待办|加个待办|清单|todo)/i.test(text) ||
    /^(完成|做完|搞定|办完).{0,12}([\p{Script=Han}A-Za-z0-9]{2,}|那个|这条|待办|清单)$/u.test(text) ||
    /(完成|做完|搞定|办完).{0,8}(待办|那个|这条|清单)/.test(text)
  );
}

export function isDocumentGenerationIntent(text: string) {
  const isProjectReport = /(工作汇报|项目汇报|日报|周报|月报|汇报工作|工作报告)/.test(text);
  if (isProjectReport) {
    return false;
  }
  const asksToWrite = /(写|生成|出|做|整理|撰写|创建|制作)/.test(text);
  const asksDocument = /(报告|文章|文档|材料|方案|说明|介绍|总结|word|Word|docx|DOCX)/.test(text);
  const asksReturn = /(返回给我|发给我|发送给我|传给我|给我|以\s*word|Word\s*形式|word\s*形式|docx|DOCX|文件)/.test(text);
  const onlySendExisting = /(生成完|刚刚|刚才|最新|最近|那个|这份|这篇).{0,12}(发|发送|给|传|返回)/.test(text);
  return asksToWrite && asksDocument && asksReturn && !onlySendExisting;
}

export function isTranslateIntent(text: string) {
  return /(翻译|译成|translate|中译英|英译中)/i.test(text);
}

function isMediaIntent(text: string) {
  if (hasFileSearchNegation(text)) {
    return false;
  }
  return (
    /(发|发送|传|返回|找|查|检索|打开|展示).{0,16}(图片|照片|截图|报告|文件|文档|word|Word|docx|DOCX|PDF|pdf|语音|视频|媒体)/.test(text) ||
    /(刚刚|刚才|刚生成|刚写|最新|最近|那个|这份|这篇).{0,16}(报告|文件|文档|word|Word|docx|DOCX)/.test(text) ||
    isBareSearchMediaIntent(text)
  );
}

function isArchiveQaIntent(text: string) {
  return /(我(?:发|传|存)过|归档|档案).{0,10}(什么|多少|哪|吗|多久|什么时候|几|是否|有没有|到什么时候|有效期|期限)/.test(text);
}

export function hasFileSearchNegation(text: string) {
  return /(不是|不想|不要|别|并非|无需|不是让你|不是叫你).{0,12}(找|查|检索|搜索|发|发送|返回).{0,12}(文件|文档|报告|word|Word|docx|DOCX)|(?:找|查|检索|搜索|发|发送|返回).{0,12}(文件|文档|报告|word|Word|docx|DOCX).{0,12}(不是|不对|不要|别)/.test(text);
}

function isKnowledgeStoreIntent(text: string) {
  return /(保存|存入|加入|记录).{0,8}(知识库|资料库|案例库|素材库|知识)/.test(text);
}

function isKnowledgeQueryIntent(text: string) {
  return /(查|查询|搜索|检索|找).{0,8}(知识库|资料库|案例库|素材库|知识|资料|案例)/.test(text);
}

function isWebSearchIntent(text: string) {
  if (
    /(知识库|资料库|案例库|素材库|归档|档案|我(?:发|传|存)过|记忆|偏好|图片|照片|截图|报告|文件|文档|word|Word|docx|DOCX|PDF|pdf|语音|视频|媒体)/.test(
      text
    )
  ) {
    return false;
  }
  return /(搜一下.{0,10}新闻|查一下.{0,10}汇率|搜索.{0,10}(新闻|最新)|百度一下|搜一搜|上网查)/.test(text);
}

function isMemoryStoreIntent(text: string) {
  if (hasExplicitMemoryQuerySignal(text) && (/^(你记得|还记得)/.test(text) || /[？?吗]|什么|哪些|是否|有没有/.test(text))) {
    return false;
  }
  return /(记住|以后记得|帮我记|保存一下|记录一下|我的偏好|我喜欢|我希望|默认用|常用格式)/.test(text);
}

function isMemoryQueryIntent(text: string) {
  return hasExplicitMemoryQuerySignal(text);
}

function shouldRunAmbiguousMediaPrecheck(text: string) {
  if (!text || text.length > 18) {
    return false;
  }
  if (/[？?吗呢]|^(为什么|怎么|如何|请问|解释|介绍|写|生成|总结)/.test(text)) {
    return false;
  }
  return /[\p{Script=Han}A-Za-z0-9]{2,}/u.test(text);
}

function isBareSearchMediaIntent(text: string) {
  const bareSearch = /^(?:帮我|麻烦(?:你)?|麻烦帮我|请帮我|请你帮我)?\s*(?:搜索|检索|查询|找|查|搜)(?:一下|一个|个|下)?\s*([\p{Script=Han}A-Za-z0-9].*)$/u.exec(text);
  if (!bareSearch) {
    return false;
  }
  if (hasExplicitMemoryQuerySignal(text)) {
    return false;
  }
  if (/(知识库|资料库|案例库|素材库|知识|资料|案例)/.test(text)) {
    return false;
  }
  if (/(天气|气温|温度|降雨|下雨|风力|weather|temperature)/i.test(text)) {
    return false;
  }
  if (/[？?吗呢]|^(为什么|怎么|如何|请问|解释|介绍)/.test(text)) {
    return false;
  }
  return /[\p{Script=Han}A-Za-z0-9]{2,}/u.test(bareSearch[1]);
}

function hasExplicitMemoryQuerySignal(text: string) {
  return /(你记得|还记得|我之前|我以前|我的偏好|我的习惯|常用格式|保存过|记录过|记忆里)/.test(text);
}
