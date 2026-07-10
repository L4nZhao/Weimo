import type OpenAI from "openai";
import { config } from "../lib/config.js";
import { getSharedOpenAI } from "../lib/openaiClient.js";
import { getRecentChatHistory } from "./chatHistoryService.js";
import { loadSkills } from "./skillLoader.js";
import { searchReports } from "./reportService.js";
import { toSignedStorageUrl } from "../lib/paths.js";
import { isStrongTextMatch } from "../lib/textMatch.js";
import {
  annotateMediaForSearch,
  listRecentMedia,
  parseGeneratedMediaSource,
  parseMetadata,
  searchMediaByText,
  type MediaType
} from "./mediaService.js";
import {
  classifyRequest,
  hasFileSearchNegation,
  isDocumentGenerationIntent,
  isProjectReportIntent,
  isWeatherIntent,
  selectRuntimeSkills,
  type RequestPlan
} from "./plannerService.js";
import { searchMemories, storeMemory } from "./memoryService.js";
import { consumePendingReminderRedeliveryPrefix, prefixReminderReply } from "./reminderScheduler.js";
import type { OutgoingMedia, Skill, SkillContext, ToolResult } from "./skillTypes.js";
import { withTimeout } from "../lib/timeout.js";

const client = getSharedOpenAI();

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type AgentOptions = {
  memoryReplyClient?: Pick<OpenAI, "chat"> | null;
  memoryReplyModel?: string;
  memoryReplyTimeoutMs?: number;
};

type RunAgentInput = {
  wechatUserId: string;
  userId: string;
  memberName: string;
  message: string;
};

type SkillPlan =
  | {
      action: "use_existing";
      skillName: string;
      reason?: string;
    }
  | {
      action: "create_skill";
      reason?: string;
      skill: {
        name?: string;
        description: string;
        instructions: string;
      };
    }
  | {
      action: "none";
      reason?: string;
    };

export async function runAgent(input: RunAgentInput, options: AgentOptions = {}) {
  const reminderPrefix = await consumePendingReminderRedeliveryPrefix(input.wechatUserId);
  const reply = await runAgentCore(input, options);
  return {
    ...reply,
    content: prefixReminderReply(reply.content, reminderPrefix)
  };
}

async function runAgentCore(input: RunAgentInput, options: AgentOptions = {}) {
  const route = await classifyRequest(input.message, { routerClient: client });
  let [skills, recentReport, recentFile, recentImage, history] = await Promise.all([
    loadSkills(),
    getMostRecentReport(input.wechatUserId),
    getMostRecentFile(input.wechatUserId),
    getMostRecentImage(input.wechatUserId),
    getRecentChatHistory(input.wechatUserId, 10)
  ]);
  const historyForPrompt = withoutCurrentUserMessage(history, input.message);
  const context: SkillContext = {
    wechatUserId: input.wechatUserId,
    userId: input.userId,
    memberName: input.memberName,
    userMessage: input.message,
    recentMessages: historyForPrompt.map((item) => ({
      role: item.role,
      content: item.content,
      createdAt: item.createdAt
    })),
    recentReport,
    recentFile,
    recentImage
  };

  const memoryFastPath = await runMemoryKnowledgeFastPath(route, context, options);
  if (memoryFastPath) {
    return memoryFastPath;
  }

  const translateFastPath = await runTranslateFastPath({
    route,
    skills,
    context
  });
  if (translateFastPath) {
    return translateFastPath;
  }

  const weatherFastPath = await runWeatherFastPath({
    message: input.message,
    skills,
    context
  });
  if (weatherFastPath) {
    return weatherFastPath;
  }

  const projectReportFastPath = await runProjectReportFastPath({
    message: input.message,
    skills,
    context,
    history: historyForPrompt
  });
  if (projectReportFastPath) {
    return projectReportFastPath;
  }

  const documentGenerationFastPath = await runDocumentGenerationFastPath({
    message: input.message,
    skills,
    context
  });
  if (documentGenerationFastPath) {
    return documentGenerationFastPath;
  }

  const targetFileSearchFastPath = await runTargetFileSearchFastPath(input.message, context);
  if (targetFileSearchFastPath) {
    return targetFileSearchFastPath;
  }

  const recentFileFastPath = runRecentFileFastPath(input.message, context);
  if (recentFileFastPath) {
    return recentFileFastPath;
  }

  if (!client) {
    return { content: "我已收到。当前还没有配置 LLM_API_KEY，暂时无法进行 AI 对话。", outgoingMedia: [] };
  }

  const planningNotes: string[] = [];
  const plan = route.allowSkillPlanner
    ? await runSkillPlanPrecheck({
        message: input.message,
        history: historyForPrompt.map((item) => ({ role: item.role, content: item.content })),
        skills
      })
    : ({ action: "none", reason: route.reason } as SkillPlan);

  if (plan.action === "create_skill") {
    const createSkill = findSkillByTool(skills, "create_skill");
    if (createSkill) {
      const result = await createSkill.execute("create_skill", plan.skill, context).catch((error) => ({
        content: error instanceof Error ? `自动创建 Skill 失败：${error.message}` : "自动创建 Skill 失败。"
      }));
      planningNotes.push(`Skill planning: ${result.content}`);
      skills = await loadSkills();
      const createdSkillName = parseCreatedSkillName(result.content) || plan.skill.name;
      const createdSkill = createdSkillName ? skills.find((skill) => skill.name === createdSkillName) : undefined;
      const instructionResult = createdSkill ? await loadPromptOnlySkillInstructions(createdSkill, context) : null;
      if (instructionResult) {
        planningNotes.push(`Skill ${createdSkill?.name} instructions:\n${instructionResult}`);
      }
    } else {
      planningNotes.push("Skill planning: 当前没有可用的 create-skill 工具，无法自动创建新 Skill。");
    }
  } else if (plan.action === "use_existing") {
    const selectedSkill = skills.find((skill) => skill.name === plan.skillName);
    planningNotes.push(
      `Skill planning: 当前请求优先使用已有 Skill「${plan.skillName}」。${plan.reason ? `原因：${plan.reason}` : ""}`
    );
    const instructionResult = selectedSkill ? await loadPromptOnlySkillInstructions(selectedSkill, context) : null;
    if (instructionResult) {
      planningNotes.push(`Skill ${selectedSkill?.name} instructions:\n${instructionResult}`);
    }
  }

  const selectedSkillName = plan.action === "use_existing" ? plan.skillName : undefined;
  const runtimeSkills = selectRuntimeSkills(skills, route, selectedSkillName);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(runtimeSkills, route)
    },
    ...planningNotes.map((content) => ({
      role: "system" as const,
      content
    })),
    ...historyForPrompt.map((item) => ({
      role: item.role,
      content: item.content
    })),
    {
      role: "user",
      content: input.message
    }
  ];
  const tools = runtimeSkills.flatMap((skill) => skill.tools);
  const skillByTool = new Map(runtimeSkills.flatMap((skill) => skill.tools.map((tool) => [tool.function.name, skill] as const)));
  const activatedSkills = new Set<string>();
  const outgoingMedia: OutgoingMedia[] = [];

  if (route.allowMediaPrecheck) {
    const mediaPrecheck = await runMediaIntentPrecheck({
      message: input.message,
      history: historyForPrompt.map((item) => ({ role: item.role, content: item.content })),
      context,
      skillByTool
    });
    if (mediaPrecheck.outgoingMedia.length) {
      return { content: buildMediaSentReply(mediaPrecheck.outgoingMedia), outgoingMedia: mediaPrecheck.outgoingMedia };
    }
  }

  for (let turn = 0; turn < config.agentMaxTurns; turn += 1) {
    const completion = await client.chat.completions.create({
      model: config.openaiModel,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      temperature: 0.4
    });

    const assistantMessage = completion.choices[0]?.message;
    if (!assistantMessage) {
      return { content: "我没有生成有效回复。", outgoingMedia };
    }

    messages.push(assistantMessage);
    const toolCalls = assistantMessage.tool_calls || [];
    if (!toolCalls.length) {
      if (outgoingMedia.length) {
        return { content: buildMediaSentReply(outgoingMedia), outgoingMedia };
      }
      return { content: normalizeFinalReply(assistantMessage.content?.trim() || "我已处理。", outgoingMedia), outgoingMedia };
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const skill = skillByTool.get(toolName);
      if (!skill) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `未知工具：${toolName}`
        });
        continue;
      }

      const args = parseToolArgs(toolCall.function.arguments);
      const result: ToolResult = await skill.execute(toolName, args, context).catch((error) => ({
        content: error instanceof Error ? `工具执行失败：${error.message}` : "工具执行失败。"
      }));
      if (result.sideEffects?.outgoingMedia?.length) {
        outgoingMedia.push(...result.sideEffects.outgoingMedia);
      }

      if (skill.name === "project-report" || skill.name === "document-generation") {
        return {
          content: result.content,
          outgoingMedia
        };
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result.content
      });

      if (skill.instructions && !activatedSkills.has(skill.name)) {
        activatedSkills.add(skill.name);
        messages.push({
          role: "system",
          content: `Skill ${skill.name} instructions:\n${skill.instructions}`
        });
      }
    }
  }

  return { content: "我已经处理了你的请求，但工具调用轮数较多，先停在这里。", outgoingMedia };
}

async function runSkillPlanPrecheck(input: {
  message: string;
  history: Array<{ role: string; content: string }>;
  skills: Skill[];
}): Promise<SkillPlan> {
  const createSkillAvailable = input.skills.some((skill) => skill.tools.some((tool) => tool.function.name === "create_skill"));
  if (shouldNeverCreateSkillForMessage(input.message)) {
    return { action: "none", reason: "当前请求属于一次性内容生成、资料查询或普通问答，应组合已有能力处理，不创建 Skill。" };
  }
  const completion = await client?.chat.completions.create({
    model: config.openaiModel,
    messages: [
      {
        role: "system",
        content: [
          "你是微信 AI 助手的 Skill 规划器，只输出 JSON，不要输出 Markdown。",
          "目标：用户提问后，先判断现有 Skill 是否适配；没有适配时，默认不创建 Skill，只有稳定、跨主题、可复用的工作流才允许创建新的提示型 Skill。",
          "决策规则：",
          "1. 如果某个现有 Skill 明确覆盖当前请求，返回 action=use_existing，并给出 skillName。",
          "2. 如果没有现有 Skill 覆盖，优先返回 action=none，让主 Agent 使用通用对话、知识库、媒体检索、文档生成等已有能力组合回答。",
          "3. 只有当请求明确代表一种长期反复使用、跨主题/跨场景、包含稳定输入输出和多步骤处理规则的工作流时，才返回 action=create_skill。",
          "4. 严禁因为不懂某个知识点、某个主题、某篇报告、某个游戏/产品/新闻/资料，就创建 Skill；这些属于知识库、网页检索或文档生成，不是 Skill。",
          "5. 写介绍、写报告、写文章、生成 Word、总结材料、查最新信息、回答事实问题、普通聊天、缺少信息、违法有害请求、泄露隐私请求、读取密钥/文件/环境变量/系统信息请求，返回 action=none。",
          "6. 自动创建的 Skill 必须是自然语言提示型 Skill：不能包含代码、Shell 命令、文件读取、环境变量读取、网络上传、Webhook、外部回传、删除数据、数据库破坏、泄露 Cookie/Session/Token/API Key/密码/私钥等内容。",
          "7. 创建 Skill 时 name 不能是某个具体主题加 report/summary/introduction；description 必须写清触发边界和不触发边界；instructions 必须是可复用工作流，不包含用户私人信息。",
          createSkillAvailable ? "create_skill 工具可用。" : "create_skill 工具不可用，因此不能返回 create_skill。",
          "",
          "可以创建 Skill 的例子：会议纪要工作流、销售周报流程、客户问题分诊流程、媒体归档审核流程。",
          "不能创建 Skill 的例子：valorant-skin-report、ai-development-report、某个产品介绍、某篇新闻总结、某类知识问答。",
          "",
          "JSON 格式：",
          "{\"action\":\"use_existing|create_skill|none\",\"skillName\":\"已有技能名\",\"reason\":\"简短原因\",\"skill\":{\"name\":\"英文小写短横线\",\"description\":\"技能用途和触发场景\",\"instructions\":\"安全、可复用的中文指令\"}}"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "现有 Skill：",
          ...input.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
          "",
          "最近上下文：",
          ...input.history.slice(-6).map((item) => `${item.role}: ${item.content}`),
          "",
          `当前用户请求：${input.message}`
        ].join("\n")
      }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  });

  return normalizeSkillPlan(completion?.choices[0]?.message.content || "", input.skills, createSkillAvailable, input.message);
}

function normalizeSkillPlan(value: string, skills: Skill[], createSkillAvailable: boolean, message: string): SkillPlan {
  try {
    const parsed = JSON.parse(value) as {
      action?: unknown;
      skillName?: unknown;
      reason?: unknown;
      skill?: {
        name?: unknown;
        description?: unknown;
        instructions?: unknown;
      };
    };
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : undefined;
    if (parsed.action === "use_existing" && typeof parsed.skillName === "string") {
      const skillName = parsed.skillName.trim();
      if (skills.some((skill) => skill.name === skillName)) {
        return { action: "use_existing", skillName, reason };
      }
    }
    if (parsed.action === "create_skill" && createSkillAvailable) {
      const skill = parsed.skill || {};
      const description = typeof skill.description === "string" ? skill.description.trim() : "";
      const instructions = typeof skill.instructions === "string" ? skill.instructions.trim() : "";
      const name = typeof skill.name === "string" ? skill.name.trim() : undefined;
      if (description.length >= 8 && instructions.length >= 20) {
        const scope = validatePlannedSkillScope({ message, name, description, instructions });
        if (!scope.ok) {
          return { action: "none", reason: scope.reason };
        }
        return {
          action: "create_skill",
          reason,
          skill: {
            name,
            description,
            instructions
          }
        };
      }
    }
  } catch {
    // Fall through to the safe default.
  }
  return { action: "none" };
}

function shouldNeverCreateSkillForMessage(message: string) {
  const text = message.trim();
  if (!text) {
    return true;
  }
  if (parseDocumentGenerationIntent(text).shouldGenerate || parseWeatherIntent(text).isWeather) {
    return true;
  }
  if (/(写|生成|撰写|做|整理|返回|发给我|发送给我|介绍|总结|分析|说明|推荐|评价|查|查询|搜索|找一下|讲讲|解释)/.test(text)) {
    if (/(报告|文章|文档|材料|方案|说明|介绍|总结|文案|资料|知识|新闻|最新|游戏|皮肤|产品|项目|论文|故事)/.test(text)) {
      return !/(创建|新增|生成|做).{0,8}(skill|Skill|技能)/i.test(text);
    }
  }
  if (/(今天|明天|最新|实时|新闻|价格|天气|汇率|股票|赛事|版本|皮肤|上线|发布|搜索|查询|联网|互联网)/.test(text)) {
    return true;
  }
  return false;
}

function validatePlannedSkillScope(input: { message: string; name?: string; description: string; instructions: string }) {
  const text = [input.message, input.name || "", input.description, input.instructions].join("\n");
  const normalizedName = String(input.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const workflowSignals = [
    /工作流|流程|步骤|规范|规则|模板|审核|审批|路由|调度|编排|归档|检索|索引|知识库/,
    /当用户|用户.*时|触发|输入|输出|多轮|上下文|状态|确认|取消|修改|重试/,
    /自动.*(提取|整理|生成|发送|保存|归档|检索|查询)|根据.*模板|生成.*文件|返回.*文件/,
    /长期|反复|重复|复用|可复用|固定格式|通用|跨主题|跨场景|能力模块/,
    /微信|机器人|Agent|Skill|工具|tool|plugin|workflow|pipeline|template|router|planner/i
  ];
  const workflowScore = workflowSignals.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  const topicSignals = [
    /关于|有关|围绕|针对|介绍|赏析|解读|科普|资料|素材|案例|单篇|一篇|一份|某个|某类/,
    /报告|文章|文案|摘要|总结|说明|方案|评论|推荐|排行榜|攻略|皮肤|游戏|新闻|趋势/,
    /\b(report|essay|article|summary|introduction|valorant|skin)\b/i
  ];
  const topicScore = topicSignals.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  if (workflowScore < 2) {
    return {
      ok: false as const,
      reason: "缺少稳定工作流特征，按普通问答/知识库/文档生成处理。"
    };
  }
  if ((topicScore >= 2 || /-(report|summary|essay|article|introduction)$/.test(normalizedName)) && workflowScore < 3) {
    return {
      ok: false as const,
      reason: "规划结果像单个主题或报告内容，不创建 Skill。"
    };
  }
  return { ok: true as const };
}

function findSkillByTool(skills: Skill[], toolName: string) {
  return skills.find((skill) => skill.tools.some((tool) => tool.function.name === toolName));
}

async function loadPromptOnlySkillInstructions(skill: Skill, context: SkillContext) {
  if (skill.tools.length !== 1) {
    return null;
  }
  const toolName = skill.tools[0]?.function.name;
  if (!toolName?.startsWith("use_")) {
    return null;
  }
  const result = await skill.execute(toolName, {}, context).catch(() => null);
  return result?.content || null;
}

function parseCreatedSkillName(content: string) {
  const match = content.match(/已创建 Skill：([a-z0-9-]+)/);
  return match?.[1];
}

function withoutCurrentUserMessage(
  history: Array<{ role: "user" | "assistant"; content: string; createdAt: Date }>,
  currentMessage: string
) {
  const trimmed = currentMessage.trim();
  if (!history.length || !trimmed) {
    return history;
  }
  const last = history[history.length - 1];
  if (last?.role === "user" && last.content.trim() === trimmed) {
    return history.slice(0, -1);
  }
  return history;
}

async function runMemoryKnowledgeFastPath(route: RequestPlan, context: SkillContext, options: AgentOptions) {
  if (route.kind === "memory-store") {
    const rawContent = extractMemoryContent(context.userMessage, "memory");
    const content = enrichExplicitMemoryContent(rawContent, context);
    if (!content) {
      return { content: "你想让我记住什么？请直接告诉我具体内容。", outgoingMedia: [] };
    }
    await storeMemory({
      wechatUserId: context.wechatUserId,
      memberName: context.memberName,
      content,
      category: "preference",
      source: "explicit-memory",
      metadata: { layer: "memory" }
    });
    await annotateReferencedMediaForSearch(rawContent, context);
    return { content: "已记住。", outgoingMedia: [] };
  }

  if (route.kind === "knowledge-store") {
    const content = extractMemoryContent(context.userMessage, "knowledge");
    if (!content) {
      return { content: "你想保存到知识库的内容是什么？请直接把资料发给我。", outgoingMedia: [] };
    }
    await storeMemory({
      wechatUserId: context.wechatUserId,
      memberName: context.memberName,
      content,
      category: "knowledge",
      source: "explicit-knowledge",
      metadata: { layer: "knowledge" }
    });
    return { content: "已保存到知识库。", outgoingMedia: [] };
  }

  if (route.kind === "memory-query" || route.kind === "knowledge-query") {
    const category = route.kind === "memory-query" ? "preference" : "knowledge";
    const query = extractQueryContent(context.userMessage) || context.userMessage;
    const memories = await searchMemories({
      wechatUserId: context.wechatUserId,
      query,
      category,
      limit: 5
    });
    if (!memories.length) {
      return {
        content: buildNoMemoryKnowledgeReply(route.kind),
        outgoingMedia: []
      };
    }
    const phrasedReply = await phraseMemoryKnowledgeReply({
      kind: route.kind,
      userMessage: context.userMessage,
      memories,
      options
    });
    return {
      content: phrasedReply || buildMemoryKnowledgeFallbackReply(route.kind, memories),
      outgoingMedia: []
    };
  }

  return null;
}

async function phraseMemoryKnowledgeReply(input: {
  kind: "memory-query" | "knowledge-query";
  userMessage: string;
  memories: Array<{ content: string }>;
  options: AgentOptions;
}) {
  const phrasingClient = input.options.memoryReplyClient === undefined ? client : input.options.memoryReplyClient;
  if (!phrasingClient) {
    return null;
  }

  try {
    const completion = await withTimeout(
      phrasingClient.chat.completions.create({
        model: input.options.memoryReplyModel || config.openaiModel,
        messages: [
          {
            role: "system",
            content: [
              "你是微信助手，负责把记忆/知识库检索结果改写成自然、直接的中文短回复。",
              "只能基于给定条目回答，禁止编造、补充或推测条目之外的信息。",
              "条目里的文件名、日期、数字、专有名词必须原样保留，不要改写错。",
              "不要机械地说“我查到这些内容”，不要逐条编号罗列；只有条目确实多且并列时才可简短分点。",
              "如果条目不足以完整回答，就如实说明只能根据这些记录回答。"
            ].join("\n")
          },
          {
            role: "user",
            content: [
              `用户原话：${input.userMessage}`,
              `检索层：${input.kind === "memory-query" ? "偏好记忆" : "知识库"}`,
              "检索到的条目：",
              ...input.memories.map((entry, index) => `${index + 1}. ${entry.content}`)
            ].join("\n")
          }
        ],
        temperature: 0.5,
        max_tokens: 220
      }),
      input.options.memoryReplyTimeoutMs ?? 2500,
      "LLM phrasing timed out"
    );
    const content = completion.choices[0]?.message.content?.trim();
    return content || null;
  } catch {
    return null;
  }
}

function buildMemoryKnowledgeFallbackReply(kind: "memory-query" | "knowledge-query", memories: Array<{ content: string }>) {
  return [
    kind === "memory-query" ? "我查到这些偏好记忆：" : "我在知识库里查到这些内容：",
    ...memories.map((entry, index) => `${index + 1}. ${entry.content}`)
  ].join("\n");
}

function buildNoMemoryKnowledgeReply(kind: "memory-query" | "knowledge-query") {
  if (kind === "memory-query") {
    return "我这边没找到相关的偏好记忆。要不要我帮你记下来？";
  }
  return "我在知识库里没搜到相关内容，可以换个关键词试试。";
}

function enrichExplicitMemoryContent(content: string, context: SkillContext) {
  const text = content.trim();
  if (!text || !context.recentImage?.caption || !shouldAttachRecentImageToMemory(text, context.recentImage.createdAt)) {
    return text;
  }
  return [
    text,
    `关联最近图片识别：${context.recentImage.caption}`,
    `关联图片文件：${context.recentImage.fileName}`
  ].join("\n");
}

function shouldAttachRecentImageToMemory(content: string, imageCreatedAt?: Date) {
  if (imageCreatedAt && Date.now() - imageCreatedAt.getTime() > 30 * 60 * 1000) {
    return false;
  }
  return /(这|这个|这张|这份|该|它|上面|里面|图中|图片|照片|截图|刚才|刚刚|刚发|刚传|刚上传)/.test(content);
}

async function runProjectReportFastPath(input: {
  message: string;
  skills: Skill[];
  context: SkillContext;
  history: Array<{ role: string; content: string }>;
}) {
  const intent = parseProjectReportIntent(input.message, input.history);
  if (!intent.isProjectReport) {
    return null;
  }
  if (intent.isFileSearchCorrection) {
    return {
      content: "明白，是我理解错了。你是在汇报工作内容，不是在找文件。请把完整汇报内容再发我一次，我会直接整理成项目汇报 Word 并发送。",
      outgoingMedia: []
    };
  }
  if (!intent.rawText) {
    return {
      content: [
        "好的，请直接发送你的工作汇报内容。",
        "可以包含：本周/本月完成内容、存在问题、下一步计划、项目名称或汇报人。收到后我会直接生成项目汇报 Word 并发送。"
      ].join("\n"),
      outgoingMedia: []
    };
  }

  const projectReportSkill = findSkillByTool(input.skills, "generate_project_report");
  if (!projectReportSkill) {
    return null;
  }
  const result = await projectReportSkill
    .execute(
      "generate_project_report",
      {
        rawText: intent.rawText
      },
      input.context
    )
    .catch((error) => ({
      content: error instanceof Error ? `项目汇报生成失败：${error.message}` : "项目汇报生成失败，请稍后重试。"
    }));

  return {
    content: result.content,
    outgoingMedia: "sideEffects" in result ? result.sideEffects?.outgoingMedia || [] : []
  };
}

function parseProjectReportIntent(message: string, history: Array<{ role: string; content: string }>) {
  const text = message.trim();
  const isFileSearchCorrection = hasFileSearchNegation(text) && /(汇报|工作内容|工作汇报|项目汇报)/.test(text);
  if (isFileSearchCorrection) {
    return { isProjectReport: true, rawText: "", isFileSearchCorrection: true };
  }

  const explicitReportIntent = isProjectReportIntent(text);
  const recentAskedForReport = history.slice(-4).some((item) => {
    const content = item.content || "";
    return /(请直接发送你的工作汇报内容|汇报对象|重点内容|工作汇报内容|生成项目汇报)/.test(content);
  });
  const looksLikeReportBody = /(完成|推进|整理|归档|沟通|协调|问题|风险|计划|下一步|本周|本月|项目|资料|任务|进展|成果)/.test(text);

  if (!explicitReportIntent && !(recentAskedForReport && looksLikeReportBody)) {
    return { isProjectReport: false, rawText: "", isFileSearchCorrection: false };
  }

  if (isProjectReportStartOnly(text)) {
    return { isProjectReport: true, rawText: "", isFileSearchCorrection: false };
  }

  return { isProjectReport: true, rawText: text, isFileSearchCorrection: false };
}

function isProjectReportStartOnly(text: string) {
  const normalized = text.replace(/[，。！？?；;：:\s]/g, "");
  if (/^(现在)?(我)?(要|想|准备|开始|进行)(写|做|提交|发送|进行)?(工作汇报|项目汇报|汇报工作)$/.test(normalized)) {
    return true;
  }
  return normalized.length <= 16 && /(工作汇报|项目汇报|汇报工作)/.test(normalized) && !/(完成|问题|计划|本周|本月|项目|内容|进展)/.test(normalized);
}

function extractMemoryContent(message: string, layer: "memory" | "knowledge") {
  const patterns =
    layer === "knowledge"
      ? [/^(?:请)?(?:保存|存入|加入|记录)(?:到|进)?(?:知识库|资料库|案例库|素材库|知识)[:：\s]*/]
      : [/^(?:请)?(?:记住|以后记得|帮我记|保存一下|记录一下)[:：\s]*/];
  let text = stripMediaAttachmentBlock(message).trim();
  for (const pattern of patterns) {
    text = text.replace(pattern, "").trim();
  }
  return text;
}

function stripMediaAttachmentBlock(message: string) {
  return message.replace(/\n{0,2}用户随消息发送了以下媒体文件：[\s\S]*$/m, "").trim();
}

function extractQueryContent(message: string) {
  return message
    .replace(/^(?:请)?(?:查|查询|搜索|检索|找)(?:一下)?(?:知识库|资料库|案例库|素材库|知识|资料|案例)?[:：\s]*/g, "")
    .replace(/你记得|还记得|我之前|我以前|我的偏好|我的习惯|常用格式|保存过|记录过|记忆里|吗|呢|？|\?/g, "")
    .trim();
}

function runRecentFileFastPath(message: string, context: SkillContext) {
  const isSendFileRequest = /(发|发送|传|给我|返回|再发|重发|找|查).{0,12}(报告|文件|文档|word|Word|docx|DOCX)|把.{0,12}(报告|文件|文档|word|Word).{0,8}(发|给|传|返回)/.test(message);
  if (!isSendFileRequest) {
    return null;
  }
  const isRecentGeneratedRequest = /(生成完|刚刚|刚才|刚生成|刚写|最新|最近|那个|这份|这篇)/.test(message);
  const recent = context.recentFile;
  if (recent) {
    const outgoingMedia: OutgoingMedia[] = [
      {
        mediaType: recent.mediaType,
        fileName: recent.fileName,
        filePath: recent.filePath,
        publicUrl: recent.publicUrl,
        delivery: "direct",
        source: recent.source || "media"
      }
    ];
    return { content: buildMediaSentReply(outgoingMedia), outgoingMedia };
  }

  if (isRecentGeneratedRequest) {
    return {
      content: "我没有找到刚生成的 Word 文档。请重新发送生成要求，我会直接生成并发送给你。",
      outgoingMedia: []
    };
  }

  if (context.recentReport) {
    const outgoingMedia: OutgoingMedia[] = [
      {
        mediaType: "file",
        fileName: `${context.recentReport.title}.docx`,
        filePath: context.recentReport.filePath,
        publicUrl: context.recentReport.publicUrl,
        delivery: "direct",
        source: "report"
      }
    ];
    return { content: buildMediaSentReply(outgoingMedia), outgoingMedia };
  }

  return null;
}

async function runTargetFileSearchFastPath(message: string, context: SkillContext) {
  const intent = parseTargetMediaSearchIntent(message);
  if (!intent.shouldSearch) {
    return null;
  }

  const [mediaItems, reports] = await Promise.all([
    intent.wantsMedia
      ? searchMediaByText({
          wechatUserId: context.wechatUserId,
          query: intent.query,
          mediaType: intent.mediaType,
          limit: 20
        })
      : Promise.resolve([]),
    intent.wantsReports
      ? searchReports({
          keyword: intent.query,
          requesterWechatUserId: context.wechatUserId,
          limit: 20
        })
      : Promise.resolve([])
  ]);

  const matchedMedia = mediaItems.filter((item) =>
    isStrongTextMatch(
      intent.query,
      [item.fileName, item.caption || "", item.metadataJson || "", item.publicUrl].join("\n")
    )
  );
  const matchedReports = reports.filter((report) =>
    isStrongTextMatch(
      intent.query,
      [report.title, report.rawText, report.summary, report.keywords, report.user?.name || "", report.project?.name || ""].join("\n")
    )
  );

  const outgoingMedia: OutgoingMedia[] = [
    ...matchedMedia.slice(0, 3).map((item) => ({
      mediaType: item.mediaType as OutgoingMedia["mediaType"],
      fileName: item.fileName,
      filePath: item.filePath,
      publicUrl: item.publicUrl,
      caption: item.caption,
      delivery: "direct" as const,
      source: parseGeneratedMediaSource(item.metadataJson)
    })),
    ...matchedReports.slice(0, Math.max(0, 3 - matchedMedia.length)).map((report) => ({
      mediaType: "file" as const,
      fileName: `${report.title}.docx`,
      filePath: report.wordFilePath,
      publicUrl: toSignedStorageUrl(report.wordFilePath, config.publicBaseUrl),
      delivery: "direct" as const,
      source: "report" as const
    }))
  ];

  if (!outgoingMedia.length) {
    return {
      content: `没有检索到与“${intent.query}”相关的${describeMediaSearchScope(intent)}。`,
      outgoingMedia: []
    };
  }

  return {
    content: buildMediaSentReply(outgoingMedia),
    outgoingMedia
  };
}

function parseTargetMediaSearchIntent(message: string) {
  if (hasFileSearchNegation(message)) {
    return { shouldSearch: false, query: "", wantsMedia: false, wantsReports: false, mediaType: undefined };
  }
  const isSendOrReturn = /(把|将|给我|返回|发|发送|传|找|查|检索|打开|展示)/.test(message);
  const mentionsTargetMedia = /(报告|文件|文档|word|Word|docx|DOCX|PDF|pdf|介绍|材料|方案|总结|图片|照片|截图|语音|音频|视频|媒体)/.test(message);
  const isGenerationRequest = parseDocumentGenerationIntent(message).shouldGenerate;
  if (!isSendOrReturn || !mentionsTargetMedia || isGenerationRequest) {
    return { shouldSearch: false, query: "", wantsMedia: false, wantsReports: false, mediaType: undefined };
  }

  const mediaType = inferRequestedMediaType(message);
  const wantsReports = mediaType === "file" && /(报告|word|Word|docx|DOCX)/.test(message);
  const wantsMedia = mediaType !== undefined || !wantsReports;
  const query = message
    .replace(/把|将|给我|返回给我|返回|发给我|发送给我|发送|发|传给我|传|找一下|查一下|找|查|检索|打开|展示/g, "")
    .replace(/生成完|刚刚|刚才|刚生成|刚写|最新|最近|那个|这份|这篇/g, "")
    .replace(/报告|文件|文档|word|Word|docx|DOCX|PDF|pdf|图片|照片|截图|语音|音频|视频|媒体/g, "")
    .replace(/[，。！？?；;：:\s]/g, "")
    .replace(/^的|的$/g, "")
    .trim();

  if (!query || query.length < 2 || /^(我|你|它|这个|那个|一下)$/.test(query)) {
    return { shouldSearch: false, query: "", wantsMedia: false, wantsReports: false, mediaType: undefined };
  }

  return { shouldSearch: true, query, wantsMedia, wantsReports, mediaType };
}

function inferRequestedMediaType(message: string): MediaType | undefined {
  if (/(图片|照片|截图)/.test(message)) {
    return "image";
  }
  if (/(语音|音频)/.test(message)) {
    return "voice";
  }
  if (/视频/.test(message)) {
    return "video";
  }
  if (/(文件|文档|PDF|pdf|word|Word|docx|DOCX|报告)/.test(message)) {
    return "file";
  }
  return undefined;
}

function describeMediaSearchScope(intent: { mediaType?: MediaType; wantsReports: boolean }) {
  if (intent.mediaType === "image") {
    return "图片";
  }
  if (intent.mediaType === "voice") {
    return "语音";
  }
  if (intent.mediaType === "video") {
    return "视频";
  }
  if (intent.mediaType === "file" && intent.wantsReports) {
    return "文件或报告";
  }
  if (intent.mediaType === "file") {
    return "文件";
  }
  return "媒体";
}

async function annotateReferencedMediaForSearch(content: string, context: SkillContext) {
  const media = selectReferencedMedia(content, context);
  if (!media) {
    return;
  }
  await annotateMediaForSearch({
    mediaId: media.id,
    note: content
  }).catch((error) => {
    console.error("Failed to annotate media search text", error);
  });
}

function selectReferencedMedia(content: string, context: SkillContext) {
  if (!shouldAttachRecentImageToMemory(content, context.recentImage?.createdAt)) {
    return undefined;
  }
  if (/(图片|照片|截图|图中|这张)/.test(content) && context.recentImage) {
    return context.recentImage;
  }
  if (/(文件|文档|报告|word|Word|docx|DOCX|PDF|pdf|这份)/.test(content) && context.recentFile) {
    return context.recentFile;
  }
  const candidates = [context.recentImage, context.recentFile]
    .filter((item): item is NonNullable<typeof item> => Boolean(item?.createdAt))
    .sort((left, right) => (right.createdAt?.getTime() || 0) - (left.createdAt?.getTime() || 0));
  return candidates[0];
}

async function runDocumentGenerationFastPath(input: { message: string; skills: Skill[]; context: SkillContext }) {
  const intent = parseDocumentGenerationIntent(input.message);
  if (!intent.shouldGenerate) {
    return null;
  }

  const documentSkill = findSkillByTool(input.skills, "generate_word_document");
  if (!documentSkill) {
    return null;
  }

  const result = await documentSkill
    .execute(
      "generate_word_document",
      {
        title: intent.title,
        prompt: input.message
      },
      input.context
    )
    .catch((error) => ({
      content: error instanceof Error ? `Word 文档生成失败：${error.message}` : "Word 文档生成失败。"
    }));

  return {
    content: result.content,
    outgoingMedia: "sideEffects" in result ? result.sideEffects?.outgoingMedia || [] : []
  };
}

function parseDocumentGenerationIntent(message: string) {
  const text = message.trim();
  if (!isDocumentGenerationIntent(text)) {
    return { shouldGenerate: false, title: "" };
  }
  return {
    shouldGenerate: true,
    title: inferDocumentTitle(text)
  };
}

function inferDocumentTitle(message: string) {
  const cleaned = message
    .replace(/请|帮我|麻烦|给我/g, "")
    .replace(/写一份|写一篇|写一个|生成一份|生成一篇|生成一个|撰写一份|撰写一篇|做一份|做一个|整理一份/g, "")
    .replace(/以\s*word\s*形式|以\s*Word\s*形式|word\s*形式|Word\s*形式|docx|DOCX/g, "")
    .replace(/返回给我|发给我|发送给我|传给我|返回|发送|发|给我/g, "")
    .replace(/[，。！？?；;：:\s]+/g, "")
    .trim();
  const title = cleaned || "Word 文档";
  return title.endsWith("报告") || title.endsWith("文章") || title.endsWith("文档") ? title : `${title}报告`;
}

async function runWeatherFastPath(input: { message: string; skills: Skill[]; context: SkillContext }) {
  const weatherIntent = parseWeatherIntent(input.message);
  if (!weatherIntent.isWeather) {
    return null;
  }

  if (!weatherIntent.city) {
    return { content: "你想查哪个城市的天气？请直接告诉我城市名，例如“北京天气”或“查怀远天气”。", outgoingMedia: [] };
  }

  const weatherSkill = findSkillByTool(input.skills, "get_weather");
  if (!weatherSkill) {
    return null;
  }

  const result = await weatherSkill
    .execute(
      "get_weather",
      {
        city: weatherIntent.city,
        days: weatherIntent.days
      },
      input.context
    )
    .catch((error) => ({
      content: error instanceof Error ? `天气查询失败：${error.message}` : "天气查询失败，请稍后重试。"
    }));

  return {
    content: result.content,
    outgoingMedia: "sideEffects" in result ? result.sideEffects?.outgoingMedia || [] : []
  };
}

async function runTranslateFastPath(input: { route: RequestPlan; skills: Skill[]; context: SkillContext }) {
  if (input.route.kind !== "translate") {
    return null;
  }

  const translateSkill = findSkillByTool(input.skills, "translate_text");
  if (!translateSkill) {
    return null;
  }

  const result = await translateSkill
    .execute(
      "translate_text",
      {
        text: extractTranslateText(input.context.userMessage),
        target_lang: extractTranslateTargetLang(input.context.userMessage)
      },
      input.context
    )
    .catch((error) => ({
      content: error instanceof Error ? `翻译失败：${error.message}` : "翻译暂时不可用，请稍后再试。"
    }));

  return {
    content: result.content,
    outgoingMedia: "sideEffects" in result ? result.sideEffects?.outgoingMedia || [] : []
  };
}

function extractTranslateText(message: string) {
  const text = message.trim();
  const colonMatch = /(?:翻译|译成|translate|中译英|英译中)[^：:]*[：:]\s*([\s\S]+)$/i.exec(text);
  if (colonMatch?.[1]?.trim()) {
    return colonMatch[1].trim();
  }

  return text
    .replace(/^(?:请|帮我|麻烦(?:你)?|麻烦帮我)?\s*/g, "")
    .replace(/^(?:把|将)?\s*/g, "")
    .replace(/(?:翻译|译成|translate|中译英|英译中)/gi, "")
    .replace(/(?:成|为|到)?(?:英文|英语|中文|汉语|中|英|English|Chinese)$/i, "")
    .replace(/^(?:我刚才那句|刚才那句|上一条|上条|刚刚那句)$/, "")
    .trim();
}

function extractTranslateTargetLang(message: string) {
  if (/(英文|英语|英译|译英|into English|to English)/i.test(message)) {
    return "English";
  }
  if (/(中文|汉语|中译|译中|into Chinese|to Chinese)/i.test(message)) {
    return "Chinese";
  }
  return undefined;
}

function parseWeatherIntent(message: string) {
  const text = message.trim();
  if (!isWeatherIntent(text)) {
    return { isWeather: false, city: "", days: 3 };
  }

  const days = 3;
  let city = text;
  const beforeWeather = text.match(/(?:查(?:一下)?|查询|看(?:一下|看)?|告诉我|帮我看)?\s*([^，。！？?；;\n]*?)(?:的)?(?:天气|气温|温度|降雨|下雨|风力|weather|temperature)/i)?.[1];
  if (beforeWeather?.trim()) {
    city = beforeWeather;
  }

  city = city
    .replace(/请问|麻烦|帮我|告诉我|查一下|查询|查|看一下|看看|看|今天|明天|后天|未来|三天|3天|最近|这几天/g, "")
    .replace(/天气|气温|温度|降雨|下雨|风力|预报|怎么样|如何|多少|会不会|吗|呢|的/g, "")
    .replace(/[，。！？?；;：:\s]/g, "")
    .trim();

  if (/^(本地|当地|这里|当前位置)$/.test(city)) {
    city = "";
  }

  return {
    isWeather: true,
    city,
    days
  };
}

async function runMediaIntentPrecheck(input: {
  message: string;
  history: Array<{ role: string; content: string }>;
  context: SkillContext;
  skillByTool: Map<string, Skill>;
}) {
  const skill = input.skillByTool.get("search_media");
  if (!skill) {
    return { outgoingMedia: [] as OutgoingMedia[] };
  }

  const completion = await client?.chat.completions.create({
    model: config.openaiModel,
    messages: [
      {
        role: "system",
        content: [
          "你是微信助手的媒体知识库意图判断器，只判断是否需要调用 search_media。",
          "当用户明确想找、查、发送、展示过去发过的图片、截图、照片、Word、文档、文件、PDF、语音、视频或媒体时，返回 shouldSearch=true。",
          "当用户只发一个短关键词、地标、物体、场景、报告标题或文件名，且结合最近上下文可能是在找已存档媒体/报告时，也返回 shouldSearch=true。",
          "当用户说“刚刚生成的报告”“刚才那个报告”“最新报告”“最近报告”“刚刚生成的 Word/文档/文件”“把报告发给我”“你刚刚生成报告发给我”等，返回 shouldSearch=true，mediaType=file，recentOnly=true，query 可用“报告”。",
          "普通百科问答、闲聊、写作、解释概念，不要检索媒体库。",
          "mediaType 可选：image、file、voice、video、report、any。Word、docx、报告用 report；PDF/普通附件用 file；不确定用 any。",
          "只输出 JSON，不要输出 Markdown。格式：{\"shouldSearch\":boolean,\"query\":\"用于检索的关键词\",\"mediaType\":\"any\",\"recentOnly\":boolean}"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "最近上下文：",
          ...input.history.slice(-6).map((item) => `${item.role}: ${item.content}`),
          "",
          `当前消息：${input.message}`
        ].join("\n")
      }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  });

  const decision = parseMediaDecision(completion?.choices[0]?.message.content || "");
  if (!decision.shouldSearch || !decision.query) {
    return { outgoingMedia: [] as OutgoingMedia[] };
  }

  const result = await skill.execute(
    "search_media",
    {
      query: decision.query,
      mediaType: decision.mediaType || "any",
      limit: decision.recentOnly ? 1 : 3,
      recentOnly: decision.recentOnly
    },
    input.context
  );
  return { outgoingMedia: result.sideEffects?.outgoingMedia || [] };
}

function buildSystemPrompt(skills: Skill[], route: RequestPlan) {
  return [
    "你是运行在微信里的 AI 助手。",
    "你需要用中文、简洁、可靠地回复用户。",
    "系统分层：Skill 是少而强的能力层；Knowledge 是内容层；Memory 是偏好层；Planner 是路由层；create-skill 是治理工具，不是兜底回答工具。",
    `当前路由：${route.layer}/${route.kind}。${route.reason}`,
    "不要编造工具结果。需要查询长期记忆时，先调用知识库工具。",
    "不要主动创建 Skill。只有当前路由是 skill/skill-governance 且用户明确要求沉淀稳定工作流时，才可以使用 create-skill。",
    "当用户询问过去发送过的图片、照片、截图、Word、文档、报告、文件、PDF、语音、视频、媒体，或只给出可能指向这些内容的短关键词时，优先调用媒体检索工具确认。",
    "如果媒体检索工具已找到文件并触发微信直接发送，最终只回复一句简短成功提示，不要输出文件名、描述、下载链接或 URL。",
    "当无法帮到用户时，建议用户发送“你能干什么”查看能力目录。",
    `当前时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
    "",
    "可用技能：",
    skills.length
      ? skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")
      : "- 当前没有可用技能。"
  ].join("\n");
}

function parseToolArgs(value: string) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseMediaDecision(value: string) {
  try {
    const parsed = JSON.parse(value) as {
      shouldSearch?: unknown;
      query?: unknown;
      mediaType?: unknown;
      recentOnly?: unknown;
    };
    return {
      shouldSearch: parsed.shouldSearch === true,
      query: typeof parsed.query === "string" ? parsed.query.trim() : "",
      mediaType: parseMediaType(parsed.mediaType),
      recentOnly: parsed.recentOnly === true
    };
  } catch {
    return { shouldSearch: false, query: "", mediaType: "any", recentOnly: false };
  }
}

function normalizeFinalReply(content: string, outgoingMedia: OutgoingMedia[]) {
  const hasMedia = outgoingMedia.length > 0;
  if (hasMedia) {
    return content;
  }
  if (/(已|正在).*(发送|发出|直接发送).*(图|文件|文档|报告|媒体)|请查收/.test(content)) {
    return "我还没有实际找到可发送的文件。你可以再给我一个更具体的文件关键词。";
  }
  return content;
}

function parseMediaType(value: unknown) {
  return ["image", "file", "voice", "video", "report", "any"].includes(String(value)) ? String(value) : "any";
}

function buildMediaSentReply(items: OutgoingMedia[]) {
  if (items.length === 1 && items[0]?.source === "generated-document") {
    return "Word 文档已发送。";
  }
  if (items.length === 1 && (items[0]?.source === "generated-report" || items[0]?.source === "report")) {
    return "报告已发送。";
  }
  if (items.length === 1 && items[0]?.mediaType === "image") {
    return "找到了，已发送图片。";
  }
  if (items.length === 1) {
    return "找到了，已发送文件。";
  }
  return `找到了，已发送 ${items.length} 个文件。`;
}

async function getMostRecentReport(wechatUserId: string) {
  const [report] = await searchReports({
    requesterWechatUserId: wechatUserId,
    limit: 1
  });
  if (!report) {
    return undefined;
  }
  return {
    id: report.id,
    title: report.title,
    filePath: report.wordFilePath,
    publicUrl: toSignedStorageUrl(report.wordFilePath, config.publicBaseUrl)
  };
}

async function getMostRecentFile(wechatUserId: string) {
  const files = await listRecentMedia({
    wechatUserId,
    mediaType: "file",
    limit: 20
  });
  const file = files.find((item) => parseGeneratedMediaSource(item.metadataJson) === "generated-document");
  if (!file) {
    return undefined;
  }
  const source: OutgoingMedia["source"] = parseGeneratedMediaSource(file.metadataJson);
  return {
    id: file.id,
    title: parseMediaTitle(file),
    fileName: file.fileName,
    filePath: file.filePath,
    publicUrl: file.publicUrl,
    mediaType: "file" as const,
    createdAt: file.createdAt,
    source
  };
}

async function getMostRecentImage(wechatUserId: string) {
  const [image] = await listRecentMedia({
    wechatUserId,
    mediaType: "image",
    limit: 1
  });
  if (!image) {
    return undefined;
  }
  return {
    id: image.id,
    title: parseMediaTitle(image),
    fileName: image.fileName,
    filePath: image.filePath,
    publicUrl: image.publicUrl,
    mediaType: "image" as const,
    caption: image.caption,
    createdAt: image.createdAt,
    source: "media" as const
  };
}

function parseMediaTitle(file: { fileName: string; metadataJson: string | null }) {
  const title = parseMetadata(file.metadataJson).title;
  if (typeof title === "string" && title.trim()) {
    return title.trim();
  }
  return file.fileName.replace(/\.docx$/i, "");
}
