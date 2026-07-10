import { Router, type Request } from "express";
import { z } from "zod";
import { config } from "../lib/config.js";
import { hmacSha256Hex, timingSafeEqualString } from "../lib/security.js";
import { confirmWechatBinding, getWechatBindingSession } from "../services/bindingService.js";
import { dispatchBotMessage } from "../services/botAdapter.js";
import { handleWechatMessage } from "../services/wechatService.js";

const router = Router();

const messageSchema = z.object({
  wechatUserId: z.string().min(1),
  memberName: z.string().optional(),
  content: z.string().min(1)
});

router.post("/message", async (req, res, next) => {
  try {
    if (!verifyWebhookRequest(req)) {
      res.status(401).json({ error: "Webhook signature required" });
      return;
    }
    const payload = messageSchema.parse(req.body);
    const reply = await handleWechatMessage(payload);
    res.json(reply);
  } catch (error) {
    next(error);
  }
});

router.post("/bot/webhook", async (req, res, next) => {
  try {
    if (!verifyWebhookRequest(req)) {
      res.status(401).json({ error: "Webhook signature required" });
      return;
    }
    const payload = z
      .object({
        externalUserId: z.string().min(1),
        displayName: z.string().optional(),
        text: z.string().min(1),
        raw: z.unknown().optional()
      })
      .parse(req.body);
    const reply = await dispatchBotMessage({
      platform: "wechat",
      externalUserId: payload.externalUserId,
      displayName: payload.displayName,
      text: payload.text,
      raw: payload.raw
    });
    res.json(reply);
  } catch (error) {
    next(error);
  }
});

router.get("/bind/scan", async (req, res, next) => {
  try {
    const token = z.string().min(1).parse(req.query.token);
    const session = await getWechatBindingSession(token);
    if (!session) {
      res.status(404).type("html").send("<h1>绑定二维码不存在</h1>");
      return;
    }
    if (session.status !== "pending") {
      res.type("html").send(`<h1>绑定状态：${session.status}</h1>`);
      return;
    }

    res.type("html").send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/project-report-assistant-icon.svg" />
    <title>微信绑定</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; line-height: 1.6; }
      form { display: grid; gap: 12px; max-width: 360px; }
      input, button { font-size: 16px; padding: 10px 12px; }
      button { background: #1677ff; border: 0; color: white; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>绑定微信</h1>
    <p>请输入微信侧用户标识完成绑定。真实微信/iLink 接入后，这里应由回调自动带入用户 ID。</p>
    <form method="post" action="/wechat/bind/confirm">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <input name="wechatUserId" placeholder="wechat user id / openid" required />
      <input name="nickname" placeholder="微信昵称，可选" />
      <button type="submit">确认绑定</button>
    </form>
  </body>
</html>`);
  } catch (error) {
    next(error);
  }
});

router.post("/bind/confirm", async (req, res, next) => {
  try {
    const payload = z
      .object({
        token: z.string().min(1),
        wechatUserId: z.string().min(1),
        nickname: z.string().optional()
      })
      .parse(req.body);
    const result = await confirmWechatBinding(payload);
    if (!result.ok) {
      res.status(400).type("html").send(`<h1>${result.reason}</h1>`);
      return;
    }
    res.type("html").send(`<h1>绑定成功</h1><p>${result.user.name} 已绑定。</p>`);
  } catch (error) {
    next(error);
  }
});

export { router as wechatRoutes };

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function verifyWebhookRequest(req: Request) {
  if (!config.requireWebhookSignature) {
    return true;
  }
  const secret = config.webhookSecret;
  if (!secret) {
    return false;
  }

  const sharedSecret = req.header("x-webhook-secret");
  if (timingSafeEqualString(sharedSecret, secret)) {
    return true;
  }

  const signature = req.header("x-weimo-signature")?.replace(/^sha256=/, "");
  const body = stableStringify(req.body);
  const expected = hmacSha256Hex(secret, body);
  return timingSafeEqualString(signature, expected);
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
