import fs from "node:fs/promises";
import path from "node:path";

const skillsDir = path.join(process.cwd(), "src", "skills");

export async function createProjectSkill(input: {
  name?: string;
  description: string;
  instructions: string;
  overwrite?: boolean;
}) {
  const safety = validateSkillAuthoringInput(input);
  if (!safety.ok) {
    throw new Error(`技能安全校验未通过：${safety.reason}`);
  }

  const name = normalizeSkillName(input.name || deriveSkillName(input.description));
  const dir = path.join(skillsDir, name);
  assertInsideSkillsDir(dir);

  const exists = await fs
    .access(dir)
    .then(() => true)
    .catch(() => false);
  if (exists && !input.overwrite) {
    throw new Error(`技能 ${name} 已存在。如需覆盖，请明确设置 overwrite=true。`);
  }

  await fs.mkdir(dir, { recursive: true });
  const skillMarkdown = buildSkillMarkdown({
    name,
    description: input.description.trim(),
    instructions: buildSafePromptInstructions(input.instructions.trim())
  });
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMarkdown, "utf8");
  await fs.writeFile(path.join(dir, "handler.js"), buildHandlerJs(name, buildSafePromptInstructions(input.instructions.trim())), "utf8");

  return {
    name,
    dir,
    skillPath: path.join(dir, "SKILL.md"),
    handlerPath: path.join(dir, "handler.js")
  };
}

export function validateSkillAuthoringInput(input: { name?: string; description: string; instructions: string }) {
  const text = [input.name || "", input.description, input.instructions].join("\n").trim();
  if (!input.description.trim() || !input.instructions.trim()) {
    return { ok: false as const, reason: "技能描述和指令不能为空。" };
  }
  if (input.description.length > 300) {
    return { ok: false as const, reason: "技能描述过长。" };
  }
  if (input.instructions.length > 6000) {
    return { ok: false as const, reason: "技能指令过长。" };
  }
  const scope = validateReusableWorkflowScope(input);
  if (!scope.ok) {
    return scope;
  }
  if (/```|<script\b|<\/script>|child_process|process\.env|import\s+fs|from\s+["']node:fs|eval\s*\(|Function\s*\(|exec\s*\(|spawn\s*\(/i.test(text)) {
    return { ok: false as const, reason: "自动创建的 Skill 只能是自然语言提示，不能包含可执行代码或系统访问指令。" };
  }
  if (
    hasUnsafeIntent(
      text,
      /(读取|导出|发送|上传|泄露|打印|展示|暴露).{0,20}(\.env|密钥|秘钥|token|api[_-]?key|password|密码|cookie|session|私钥|ssh)/gi
    )
  ) {
    return { ok: false as const, reason: "技能不能要求读取、暴露或外传密钥、密码、Cookie、Session 等私密信息。" };
  }
  if (hasUnsafeIntent(text, /(发送|上传|同步|转发|post|webhook).{0,30}(http:\/\/|https:\/\/|外部|第三方|服务器|接口)/gi)) {
    return { ok: false as const, reason: "技能不能要求把用户信息或项目数据发送到外部服务。" };
  }
  if (hasUnsafeIntent(text, /(删除|清空|格式化|覆盖).{0,20}(文件|目录|数据库|记录|数据|磁盘)|rm\s+-rf|drop\s+table|truncate\s+table/gi)) {
    return { ok: false as const, reason: "技能不能包含破坏性文件或数据库操作。" };
  }
  return { ok: true as const };
}

function validateReusableWorkflowScope(input: { name?: string; description: string; instructions: string }) {
  const text = [input.name || "", input.description, input.instructions].join("\n");
  const normalizedName = normalizeSkillName(input.name || input.description);
  const workflowSignals = [
    /工作流|流程|步骤|规范|规则|模板|表单|审核|审批|路由|调度|编排|归档|检索|索引|记忆|知识库/,
    /当用户|用户.*时|触发|输入|输出|多轮|上下文|状态|确认|取消|修改|重试/,
    /自动.*(提取|整理|生成|发送|保存|归档|检索|查询)|根据.*模板|生成.*文件|返回.*文件/,
    /长期|反复|重复|复用|可复用|固定格式|通用|跨主题|跨场景|能力模块/,
    /微信|机器人|Agent|Skill|工具|tool|plugin|workflow|pipeline|template|router|planner/i
  ];
  const workflowScore = workflowSignals.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  const singleTopicSignals = [
    /关于|有关|围绕|针对|介绍|赏析|解读|科普|资料|素材|案例|单篇|一篇|一份|某个|某类/,
    /报告|文章|文案|摘要|总结|说明|方案|评论|推荐|排行榜|攻略|皮肤|游戏|新闻|趋势/,
    /\b(report|essay|article|summary|introduction|valorant|skin)\b/i
  ];
  const singleTopicScore = singleTopicSignals.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  const looksLikeTopicReport = /-(report|summary|essay|article|introduction)$/.test(normalizedName) || singleTopicScore >= 2;

  if (workflowScore < 2) {
    return {
      ok: false as const,
      reason:
        "create-skill 只允许沉淀稳定、可复用的工作流。单次问答、知识主题、报告主题或内容写作需求应使用知识库、检索或文档生成能力。"
    };
  }
  if (looksLikeTopicReport && workflowScore < 3) {
    return {
      ok: false as const,
      reason:
        "该需求更像单个主题/报告内容，不应创建独立 Skill。请改用 document-generation 或 knowledge，并只在形成跨主题工作流时创建 Skill。"
    };
  }
  return { ok: true as const };
}

export function normalizeSkillName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54)
    .replace(/-+$/g, "");
  return normalized || "custom-skill";
}

function deriveSkillName(description: string) {
  const asciiWords = description.match(/[A-Za-z0-9]+/g);
  if (asciiWords?.length) {
    return asciiWords.slice(0, 6).join("-");
  }
  return `skill-${Date.now().toString(36)}`;
}

function buildSafePromptInstructions(instructions: string) {
  return [
    "安全边界：这是提示型 Skill，不包含也不得要求执行任意代码、Shell 命令、文件系统读取、环境变量读取、密钥读取、Cookie/Session 读取，或向外部服务发送用户隐私与项目数据。",
    "如果用户请求涉及隐私泄露、密钥、未授权文件、破坏性操作或外传数据，必须拒绝并给出安全替代建议。",
    "",
    instructions
  ].join("\n");
}

function hasUnsafeIntent(text: string, pattern: RegExp) {
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const prefix = text.slice(Math.max(0, index - 12), index);
    if (!/(不要|不得|不能|禁止|避免|拒绝|不允许|不可)$/.test(prefix.trim())) {
      return true;
    }
  }
  return false;
}

function assertInsideSkillsDir(dir: string) {
  const relative = path.relative(skillsDir, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("技能目录必须位于 src/skills 内。");
  }
}

function buildSkillMarkdown(input: { name: string; description: string; instructions: string }) {
  return [
    "---",
    `name: ${input.name}`,
    `description: ${escapeFrontmatter(input.description)}`,
    "---",
    "",
    input.instructions,
    ""
  ].join("\n");
}

function buildHandlerJs(skillName: string, instructions: string) {
  const toolName = `use_${skillName.replace(/-/g, "_")}`.slice(0, 64);
  return [
    `const instructions = ${JSON.stringify(instructions)};`,
    "",
    "export const tools = [",
    "  {",
    '    type: "function",',
    "    function: {",
    `      name: ${JSON.stringify(toolName)},`,
    `      description: ${JSON.stringify(`加载并应用 ${skillName} 技能的详细指令。`)},`,
    "      parameters: {",
    '        type: "object",',
    "        properties: {},",
    "        additionalProperties: false",
    "      }",
    "    }",
    "  }",
    "];",
    "",
    "export async function execute() {",
    "  return {",
    `    content: ${JSON.stringify(`已加载 ${skillName} 技能。请按以下指令处理当前请求：`)} + "\\n\\n" + instructions`,
    "  };",
    "}",
    ""
  ].join("\n");
}

function escapeFrontmatter(value: string) {
  return JSON.stringify(value);
}
