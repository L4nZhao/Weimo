import { prisma } from "../lib/prisma.js";

export async function ensureWechatUser(wechatUserId: string, fallbackName?: string) {
  const cleanFallbackName = normalizeDisplayName(fallbackName, wechatUserId);
  const existing = await prisma.user.findUnique({
    where: { wechatUserId },
    include: { project: true }
  });

  if (existing) {
    if (cleanFallbackName && shouldReplaceName(existing.name, wechatUserId)) {
      return prisma.user.update({
        where: { id: existing.id },
        data: { name: cleanFallbackName },
        include: { project: true }
      });
    }
    return existing;
  }

  const project = await prisma.project.upsert({
    where: { name: "默认项目" },
    create: { name: "默认项目", description: "MVP 默认项目" },
    update: {}
  });

  return prisma.user.create({
    data: {
      wechatUserId,
      name: cleanFallbackName || "未绑定成员",
      role: wechatUserId === "admin" ? "admin" : "member",
      projectId: project.id
    },
    include: { project: true }
  });
}

function normalizeDisplayName(name: string | undefined, wechatUserId: string) {
  const value = name?.trim();
  if (!value || value === wechatUserId || value.includes("@im.wechat") || value === "微信机器人" || /^微信用户/.test(value)) {
    return undefined;
  }
  return value;
}

function shouldReplaceName(name: string, wechatUserId: string) {
  return (
    !name ||
    name === wechatUserId ||
    name.includes("@im.wechat") ||
    name === "未绑定成员" ||
    name === "微信机器人" ||
    /^微信用户/.test(name)
  );
}
