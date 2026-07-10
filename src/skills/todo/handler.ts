import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "add_todo",
      description: "添加一条待办事项。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "待办内容，例如 买机票、提交周报、预约体检"
          }
        },
        required: ["content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "列出当前用户所有未完成待办。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_todo",
      description: "按内容关键词完成一条未完成待办；多条匹配时列出候选让用户选择。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "用于匹配待办内容的关键词"
          }
        },
        required: ["keyword"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clear_done_todos",
      description: "清理当前用户所有已完成待办。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  switch (toolName) {
    case "add_todo":
      return addTodo(args, context);
    case "list_todos":
      return listTodos(context);
    case "complete_todo":
      return completeTodo(args, context);
    case "clear_done_todos":
      return clearDoneTodos(context);
    default:
      return { content: `未知工具：${toolName}` };
  }
}

async function addTodo(args: Record<string, unknown>, context: SkillContext) {
  const payload = z
    .object({
      content: z.string().trim().min(1)
    })
    .parse(args);

  await prisma.todoItem.create({
    data: {
      wechatUserId: context.wechatUserId,
      content: payload.content,
      status: "open"
    }
  });

  return { content: `已加入待办：${payload.content}。` };
}

async function listTodos(context: SkillContext) {
  const todos = await prisma.todoItem.findMany({
    where: {
      wechatUserId: context.wechatUserId,
      status: "open"
    },
    orderBy: { createdAt: "asc" }
  });

  if (!todos.length) {
    return { content: "你现在没有未完成的待办。" };
  }

  return {
    content: ["你当前的待办：", ...todos.map((todo, index) => formatTodoLine(todo, index))].join("\n")
  };
}

async function completeTodo(args: Record<string, unknown>, context: SkillContext) {
  const payload = z
    .object({
      keyword: z.string().trim().min(1)
    })
    .parse(args);

  const matches = await prisma.todoItem.findMany({
    where: {
      wechatUserId: context.wechatUserId,
      status: "open",
      content: { contains: payload.keyword }
    },
    orderBy: { createdAt: "asc" }
  });

  if (!matches.length) {
    return { content: `没有找到包含“${payload.keyword}”的未完成待办。` };
  }
  if (matches.length > 1) {
    return {
      content: [
        `找到 ${matches.length} 条包含“${payload.keyword}”的待办，请告诉我要完成哪一条：`,
        ...matches.map((todo, index) => formatTodoLine(todo, index))
      ].join("\n")
    };
  }

  await prisma.todoItem.update({
    where: { id: matches[0].id },
    data: {
      status: "done",
      doneAt: new Date()
    }
  });
  return { content: `已完成待办：${matches[0].content}。` };
}

async function clearDoneTodos(context: SkillContext) {
  const result = await prisma.todoItem.deleteMany({
    where: {
      wechatUserId: context.wechatUserId,
      status: "done"
    }
  });

  if (!result.count) {
    return { content: "没有已完成的待办需要清理。" };
  }
  return { content: `已清理 ${result.count} 条已完成待办。` };
}

function formatTodoLine(todo: { content: string }, index: number) {
  return `${index + 1}. ${todo.content}`;
}
