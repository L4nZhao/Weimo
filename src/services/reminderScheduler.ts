import type { Reminder } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendIlinkTextForBot } from "./ilinkService.js";

export type ReminderDelivery = {
  reminderId: string;
  botId: string;
  toUserId: string;
  contextToken: string;
  content: string;
};

export type ReminderSender = (input: ReminderDelivery) => Promise<unknown>;

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export function startReminderScheduler(sender: ReminderSender = defaultReminderSender) {
  console.log("Reminder scheduler started.");
  return setInterval(() => {
    runReminderSweep(new Date(), sender).catch((error) => {
      console.error("Reminder scheduler sweep failed", error);
    });
  }, DEFAULT_SWEEP_INTERVAL_MS);
}

export async function runReminderSweep(now: Date, sender: ReminderSender = defaultReminderSender) {
  const dueReminders = await prisma.reminder.findMany({
    where: {
      status: "active",
      nextFireAt: { lte: now }
    },
    orderBy: { nextFireAt: "asc" }
  });

  let sentCount = 0;
  let pendingRedeliveryCount = 0;

  for (const reminder of dueReminders) {
    const state = await prisma.wechatConversationState.findUnique({
      where: { wechatUserId: reminder.wechatUserId }
    });

    if (!state?.lastContextToken || !state.lastIlinkBotId) {
      await markPendingRedelivery(reminder.id, now);
      pendingRedeliveryCount += 1;
      continue;
    }

    try {
      await sender({
        reminderId: reminder.id,
        botId: state.lastIlinkBotId,
        toUserId: reminder.wechatUserId,
        contextToken: state.lastContextToken,
        content: `⏰ 提醒：${reminder.content}`
      });
      await markReminderDelivered(reminder, now);
      sentCount += 1;
    } catch (error) {
      console.warn("Reminder delivery failed; queued for redelivery", error);
      await markPendingRedelivery(reminder.id, now);
      pendingRedeliveryCount += 1;
    }
  }

  return {
    checkedCount: dueReminders.length,
    sentCount,
    pendingRedeliveryCount
  };
}

export async function consumePendingReminderRedeliveryPrefix(wechatUserId: string) {
  const reminders = await prisma.reminder.findMany({
    where: {
      wechatUserId,
      status: "pending-redelivery"
    },
    orderBy: { nextFireAt: "asc" }
  });

  if (!reminders.length) {
    return "";
  }

  const now = new Date();
  for (const reminder of reminders) {
    if (reminder.recurrence === "none") {
      await prisma.reminder.updateMany({
        where: { id: reminder.id, status: "pending-redelivery" },
        data: { status: "sent" }
      });
      continue;
    }
    // 周期性提醒补投后要回到 active 并推进到下一个未来周期，否则周期会断
    let next = advanceFireAt(reminder.nextFireAt, reminder.recurrence);
    while (next <= now) {
      next = advanceFireAt(next, reminder.recurrence);
    }
    await prisma.reminder.updateMany({
      where: { id: reminder.id, status: "pending-redelivery" },
      data: { status: "active", nextFireAt: next }
    });
  }

  return formatPendingReminderPrefix(reminders);
}

export function prefixReminderReply(content: string, prefix: string) {
  return prefix ? `${prefix}${content}` : content;
}

async function defaultReminderSender(input: ReminderDelivery) {
  return sendIlinkTextForBot({
    botId: input.botId,
    toUserId: input.toUserId,
    contextToken: input.contextToken,
    content: input.content
  });
}

async function markReminderDelivered(reminder: Reminder, firedAt: Date) {
  if (reminder.recurrence === "none") {
    await prisma.reminder.updateMany({
      where: { id: reminder.id, status: "active" },
      data: {
        status: "sent",
        lastFiredAt: firedAt
      }
    });
    return;
  }

  await prisma.reminder.updateMany({
    where: { id: reminder.id, status: "active" },
    data: {
      nextFireAt: advanceFireAt(reminder.nextFireAt, reminder.recurrence),
      lastFiredAt: firedAt
    }
  });
}

async function markPendingRedelivery(reminderId: string, firedAt: Date) {
  await prisma.reminder.updateMany({
    where: { id: reminderId, status: "active" },
    data: {
      status: "pending-redelivery",
      lastFiredAt: firedAt
    }
  });
}

function advanceFireAt(nextFireAt: Date, recurrence: string) {
  const advanced = new Date(nextFireAt);
  switch (recurrence) {
    case "daily":
      advanced.setDate(advanced.getDate() + 1);
      return advanced;
    case "weekly":
      advanced.setDate(advanced.getDate() + 7);
      return advanced;
    case "monthly":
      advanced.setMonth(advanced.getMonth() + 1);
      return advanced;
    default:
      return advanced;
  }
}

function formatPendingReminderPrefix(reminders: Reminder[]) {
  if (reminders.length === 1) {
    return `对了，你有1条到期提醒：${reminders[0].content}\n\n`;
  }

  return [
    `对了，你有${reminders.length}条到期提醒：`,
    ...reminders.map((reminder, index) => `${index + 1}. ${reminder.content}`),
    "",
    ""
  ].join("\n");
}
