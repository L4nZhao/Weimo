import { loadSkills } from "../../services/skillLoader.js";
import type { Skill, SkillContext, ToolDef } from "../../services/skillTypes.js";

const EXAMPLES_BY_SKILL: Record<string, string> = {
  "assistant-help": "你能干什么？",
  "create-skill": "把客户问题分诊流程沉淀成一个技能。",
  "document-generation": "帮我生成一份活动复盘 Word 文档。",
  knowledge: "记住我的会议纪要默认用中文简洁版。",
  "media-search": "找一下我之前发过的东方明珠图片。",
  "project-report": "我来提交项目汇报：本周完成了接口联调和模板整理。",
  translate: "帮我翻译成英文：你好。",
  "web-search": "搜一下今天的新闻。",
  "weather-query": "上海明天会下雨吗？"
};

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_capabilities",
      description: "列出当前助手实际加载的 Skill 能力目录，并给出每个能力的使用例句。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, _args: Record<string, unknown>, _context: SkillContext) {
  if (toolName !== "list_capabilities") {
    return { content: `未知工具：${toolName}` };
  }

  const skills = await loadSkills();
  const lines = skills.map(formatSkillCapability);

  return {
    content: ["我现在可以帮你处理这些事，你可以直接按例句这样问：", ...lines].join("\n")
  };
}

function formatSkillCapability(skill: Skill) {
  const example = EXAMPLES_BY_SKILL[skill.name] || skill.description;
  return `- ${skill.name}：${skill.description} 例句：${example}`;
}
