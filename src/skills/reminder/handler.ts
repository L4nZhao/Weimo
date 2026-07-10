import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

const recurrenceValues = ["none", "daily", "weekly", "monthly"] as const;

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "设置一条提醒。fire_at 必须是 Asia/Shanghai 的未来时间 ISO 字符串。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "提醒内容，例如 开会、提交周报、吃药"
          },
          fire_at: {
            type: "string",
            description: "Asia/Shanghai 的未来时间 ISO 字符串，例如 2026-07-10T15:00:00+08:00"
          },
          recurrence: {
            type: "string",
            enum: recurrenceValues,
            description: "重复周期，默认 none"
          }
        },
        required: ["content", "fire_at"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "列出当前用户所有 active 提醒。",
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
      name: "cancel_reminder",
      description: "按内容关键词取消 active 提醒；多条匹配时列出候选让用户选择。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "用于匹配提醒内容的关键词"
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
      name: "snooze_reminder",
      description: "把最近一次已触发并标记 sent 的提醒推迟若干分钟后重新激活。",
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description: "推迟分钟数，必须为正整数"
          }
        },
        required: ["minutes"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  switch (toolName) {
    case "set_reminder":
      return setReminder(args, context);
    case "list_reminders":
      return listReminders(context);
    case "cancel_reminder":
      return cancelReminder(args, context);
    case "snooze_reminder":
      return snoozeReminder(args, context);
    default:
      return { content: `未知工具：${toolName}` };
  }
}

async function setReminder(args: Record<string, unknown>, context: SkillContext) {
  const payload = z
    .object({
      content: z.string().trim().min(1),
      fire_at: z.string().trim().min(1),
      recurrence: z.enum(recurrenceValues).optional().default("none")
    })
    .parse(args);
  const nextFireAt = new Date(payload.fire_at);
  const now = new Date();

  if (Number.isNaN(nextFireAt.getTime())) {
    return { content: "提醒时间格式不对。请给我一个明确的未来时间。" };
  }
  if (nextFireAt.getTime() <= now.getTime()) {
    return { content: "这个时间已经过去了。请换一个未来时间。" };
  }

  await prisma.reminder.create({
    data: {
      wechatUserId: context.wechatUserId,
      content: payload.content,
      nextFireAt,
      recurrence: payload.recurrence,
      status: "active"
    }
  });

  return {
    content: `已设置提醒：${payload.content}，时间 ${formatFriendlyTime(nextFireAt)}${formatRecurrence(payload.recurrence)}。`
  };
}

async function listReminders(context: SkillContext) {
  const reminders = await prisma.reminder.findMany({
    where: {
      wechatUserId: context.wechatUserId,
      status: "active"
    },
    orderBy: { nextFireAt: "asc" }
  });

  if (!reminders.length) {
    return { content: "你现在没有待触发的提醒。" };
  }

  return {
    content: ["你当前的提醒：", ...reminders.map((reminder, index) => formatReminderLine(reminder, index))].join("\n")
  };
}

async function cancelReminder(args: Record<string, unknown>, context: SkillContext) {
  const payload = z
    .object({
      keyword: z.string().trim().min(1)
    })
    .parse(args);

  const matches = await prisma.reminder.findMany({
    where: {
      wechatUserId: context.wechatUserId,
      status: "active",
      content: { contains: payload.keyword }
    },
    orderBy: { nextFireAt: "asc" }
  });

  if (!matches.length) {
    return { content: `没有找到包含“${payload.keyword}”的待触发提醒。` };
  }
  if (matches.length > 1) {
    return {
      content: [
        `找到 ${matches.length} 条包含“${payload.keyword}”的提醒，请告诉我要取消哪一条：`,
        ...matches.map((reminder, index) => formatReminderLine(reminder, index))
      ].join("\n")
    };
  }

  await prisma.reminder.update({
    where: { id: matches[0].id },
    data: { status: "cancelled" }
  });
  return { content: `已取消提醒：${matches[0].content}。` };
}

async function snoozeReminder(args: Record<string, unknown>, context: SkillContext) {
  const payload = z
    .object({
      minutes: z.number().int().min(1)
    })
    .parse(args);
  const reminder = await prisma.reminder.findFirst({
    where: {
      wechatUserId: context.wechatUserId,
      status: "sent",
      lastFiredAt: { not: null }
    },
    orderBy: { lastFiredAt: "desc" }
  });

  if (!reminder) {
    return { content: "没有找到刚触发过的提醒可以推迟。" };
  }

  const nextFireAt = new Date(Date.now() + payload.minutes * 60_000);
  await prisma.reminder.update({
    where: { id: reminder.id },
    data: {
      status: "active",
      nextFireAt
    }
  });

  return { content: `已推迟提醒：${reminder.content}，新的时间 ${formatFriendlyTime(nextFireAt)}。` };
}

function formatReminderLine(reminder: { content: string; nextFireAt: Date; recurrence: string }, index: number) {
  return `${index + 1}. ${reminder.content}：${formatFriendlyTime(reminder.nextFireAt)}${formatRecurrence(reminder.recurrence)}`;
}

function formatFriendlyTime(date: Date) {
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRecurrence(recurrence: string) {
  switch (recurrence) {
    case "daily":
      return "，每天重复";
    case "weekly":
      return "，每周重复";
    case "monthly":
      return "，每月重复";
    default:
      return "";
  }
}
