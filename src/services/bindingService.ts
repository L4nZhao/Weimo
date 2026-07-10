import crypto from "node:crypto";
import QRCode from "qrcode";
import { config } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";

const BINDING_TTL_MINUTES = 10;

export async function createWechatBindingSession(input: {
  targetName?: string;
  targetRole?: string;
  targetProjectId?: string;
}) {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + BINDING_TTL_MINUTES * 60 * 1000);
  const bindUrl = `${config.wechatBindBaseUrl}/wechat/bind/scan?token=${encodeURIComponent(token)}`;
  const qrSvg = await QRCode.toString(bindUrl, {
    type: "svg",
    margin: 1,
    width: 280
  });
  const session = await prisma.wechatBindingSession.create({
    data: {
      token,
      targetName: input.targetName,
      targetRole: input.targetRole || "member",
      targetProjectId: input.targetProjectId,
      expiresAt
    }
  });

  return {
    session,
    bindUrl,
    qrSvg,
    expiresInSeconds: BINDING_TTL_MINUTES * 60
  };
}

export async function getWechatBindingSession(token: string) {
  const session = await prisma.wechatBindingSession.findUnique({
    where: { token },
    include: { user: true }
  });
  if (!session) {
    return null;
  }
  if (session.status === "pending" && session.expiresAt.getTime() < Date.now()) {
    return prisma.wechatBindingSession.update({
      where: { token },
      data: { status: "expired" },
      include: { user: true }
    });
  }
  return session;
}

export async function confirmWechatBinding(input: {
  token: string;
  wechatUserId: string;
  nickname?: string;
}) {
  const session = await getWechatBindingSession(input.token);
  if (!session || session.status !== "pending") {
    return { ok: false as const, reason: "绑定二维码已失效或不存在" };
  }

  const projectId = session.targetProjectId || (await ensureDefaultProjectId());
  const user = await prisma.user.upsert({
    where: { wechatUserId: input.wechatUserId },
    create: {
      wechatUserId: input.wechatUserId,
      name: session.targetName || input.nickname || input.wechatUserId,
      role: session.targetRole,
      projectId
    },
    update: {
      name: session.targetName || input.nickname || undefined,
      role: session.targetRole,
      projectId
    }
  });
  const updated = await prisma.wechatBindingSession.update({
    where: { token: input.token },
    data: {
      status: "confirmed",
      wechatUserId: input.wechatUserId,
      userId: user.id,
      confirmedAt: new Date()
    },
    include: { user: true }
  });

  return { ok: true as const, session: updated, user };
}

async function ensureDefaultProjectId() {
  const project = await prisma.project.upsert({
    where: { name: "默认项目" },
    create: { name: "默认项目", description: "MVP 默认项目" },
    update: {}
  });
  return project.id;
}
