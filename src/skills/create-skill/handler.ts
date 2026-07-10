import { z } from "zod";
import { createProjectSkill } from "../../services/skillAuthoringService.js";
import { reloadSkills } from "../../services/skillLoader.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "create_skill",
      description:
        "仅在需求是长期反复使用、跨主题/跨场景的稳定工作流时，创建或更新项目内置 Skill。不要为单个知识主题、报告主题、介绍文章或一次性问答创建 Skill。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "技能名，使用英文小写和短横线；必须描述通用工作流，例如 meeting-minutes-workflow"
          },
          description: {
            type: "string",
            description: "技能用途、触发场景和不触发场景，会出现在 Agent 的技能列表里"
          },
          instructions: {
            type: "string",
            description: "写给 Agent 的详细工作流指令，包含输入、输出、步骤、约束、复用边界和必要示例"
          },
          overwrite: {
            type: "boolean",
            description: "是否覆盖同名技能。只有用户明确要求覆盖时设置 true"
          }
        },
        required: ["description", "instructions"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  if (toolName !== "create_skill") {
    return { content: `未知工具：${toolName}` };
  }

  const payload = z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().min(8),
      instructions: z.string().min(20),
      overwrite: z.boolean().optional()
    })
    .parse(args);

  const skill = await createProjectSkill(payload);
  await reloadSkills();

  return {
    content: [
      `已创建 Skill：${skill.name}`,
      `创建人：${context.memberName}`,
      `说明文件：${skill.skillPath}`,
      `工具文件：${skill.handlerPath}`,
      "新技能已热加载，后续对话可以直接使用。"
    ].join("\n")
  };
}
