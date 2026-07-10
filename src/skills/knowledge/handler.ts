import { z } from "zod";
import { searchMemories, storeMemory } from "../../services/memoryService.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "store_memory",
      description: "把用户明确要求保留的信息写入长期层。偏好/习惯用 category=preference；资料/案例/主题知识用 category=knowledge。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要保存的记忆内容" },
          category: { type: "string", description: "分类，例如 preference、knowledge、project、general" }
        },
        required: ["content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_memory",
      description: "按语义或关键词查询长期层。查用户偏好用 category=preference；查资料、案例、主题知识用 category=knowledge。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "查询内容" },
          category: { type: "string", description: "可选分类过滤" },
          limit: { type: "number", description: "返回条数，默认 5" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  if (toolName === "store_memory") {
    const payload = z
      .object({
        content: z.string().min(1),
        category: z.string().optional()
      })
      .parse(args);
    const entry = await storeMemory({
      wechatUserId: context.wechatUserId,
      memberName: context.memberName,
      content: payload.content,
      category: payload.category,
      source: "skill"
    });
    return {
      content: `已保存记忆：${entry.content}`
    };
  }

  if (toolName === "query_memory") {
    const payload = z
      .object({
        query: z.string().min(1),
        category: z.string().optional(),
        limit: z.coerce.number().int().positive().max(20).optional()
      })
      .parse(args);
    const memories = await searchMemories({
      wechatUserId: context.wechatUserId,
      query: payload.query,
      category: payload.category,
      limit: payload.limit
    });
    if (!memories.length) {
      return { content: "没有找到相关记忆。" };
    }
    return {
      content: memories
        .map((entry, index) => `${index + 1}. [${entry.category}] ${entry.content}`)
        .join("\n")
    };
  }

  return { content: `未知工具：${toolName}` };
}
