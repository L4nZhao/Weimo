import { prisma } from "../lib/prisma.js";
import { ensureWechatUser } from "./userService.js";

export async function getRecentChatHistory(wechatUserId: string, limit = 10) {
  const rows = await prisma.wechatChatMessage.findMany({
    where: { wechatUserId },
    orderBy: { createdAt: "desc" },
    take: limit
  });

  return rows.reverse().map((row) => ({
    role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: row.content,
    createdAt: row.createdAt
  }));
}

export async function appendChatMessage(input: {
  wechatUserId: string;
  memberName?: string;
  role: "user" | "assistant";
  content: string;
}) {
  const user = await ensureWechatUser(input.wechatUserId, input.memberName);
  return prisma.wechatChatMessage.create({
    data: {
      wechatUserId: input.wechatUserId,
      userId: user.id,
      role: input.role,
      content: input.content
    }
  });
}
