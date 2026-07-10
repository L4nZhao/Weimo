import crypto from "node:crypto";
import type { IlinkBotQrSession, IlinkBotState } from "@prisma/client";
import QRCode from "qrcode";
import { config } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { dispatchBotMessage } from "./botAdapter.js";
import { createMediaRecord, persistMedia, recognizeAndIndexImageMedia, type MediaType } from "./mediaService.js";
import type { OutgoingMedia } from "./skillTypes.js";
import { ensureWechatUser } from "./userService.js";
import { describeVoiceMedia } from "./voiceTranscriptionService.js";

type IlinkResponse = Record<string, any>;

type IlinkMessage = {
  from_user_id?: string;
  from_user_name?: string;
  from_username?: string;
  from_wxid?: string;
  sender?: string;
  nickname?: string;
  from_nickname?: string;
  sender_nickname?: string;
  sender_name?: string;
  display_name?: string;
  remark_name?: string;
  alias?: string;
  msgid?: string;
  msg_id?: string;
  message_type?: number | string;
  msg_type?: number | string;
  context_token?: string;
  content?: string;
  text?: string;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    image_item?: IlinkMediaItem;
    voice_item?: IlinkMediaItem & { text?: string; voice_text?: string };
    file_item?: IlinkMediaItem & { file_name?: string; file_size?: number };
    video_item?: IlinkMediaItem & { duration_ms?: number };
  }>;
};

type IlinkMediaItem = {
  aeskey?: string;
  aes_key?: string;
  encrypt_query_param?: string;
  full_url?: string;
  url?: string;
  download_url?: string;
  file_url?: string;
  media?: {
    encrypt_query_param?: string;
    aes_key?: string;
    full_url?: string;
  };
};

export async function listIlinkBots() {
  const bot = await getCurrentIlinkBot();
  return bot ? [await withQrSvg(bot)] : [];
}

export async function createIlinkBotQrSession(input: { name?: string }) {
  const data = await ilinkGet("/ilink/bot/get_bot_qrcode", {
    bot_type: "3"
  });
  if (!data.qrcode) {
    throw new Error("iLink 未返回机器人二维码。");
  }

  const session = await prisma.ilinkBotQrSession.create({
    data: {
      name: input.name?.trim() || "微信机器人",
      status: "waiting_scan",
      qrcode: data.qrcode,
      qrcodeContent: data.qrcode_img_content || data.qrcode_content,
      lastError: null
    }
  });
  return withQrSvg(session);
}

export async function getIlinkBotQrSession(sessionId: string) {
  const session = await prisma.ilinkBotQrSession.findUnique({
    where: { id: sessionId }
  });
  return session ? withQrSvg(session) : null;
}

export async function refreshIlinkQrSession(sessionId: string) {
  const session = await prisma.ilinkBotQrSession.findUnique({
    where: { id: sessionId }
  });
  if (!session) {
    throw new Error("二维码会话不存在。");
  }

  const data = await ilinkGet("/ilink/bot/get_qrcode_status", {
    qrcode: session.qrcode
  });
  const status = normalizeLoginStatus(data.status);

  if (status !== "online") {
    const updated = await prisma.ilinkBotQrSession.update({
      where: { id: sessionId },
      data: {
        status,
        lastError: data.errmsg || null
      }
    });
    return withQrSvg(updated);
  }

  const bot = await prisma.$transaction(async (tx) => {
    await tx.ilinkBotState.updateMany({
      where: { status: { not: "deleted" } },
      data: {
        status: "deleted",
        botToken: null,
        lastError: "已被新的微信机器人接入替换"
      }
    });
    return tx.ilinkBotState.create({
      data: {
        name: session.name || "微信机器人",
        status: "online",
        qrcode: session.qrcode,
        qrcodeContent: session.qrcodeContent,
        botToken: data.bot_token || data.token || null,
        ilinkBotId: data.ilink_bot_id || null,
        ilinkUserId: data.ilink_user_id || null,
        baseUrl: data.baseurl || config.ilinkBaseUrl,
        loggedInAt: new Date(),
        lastError: null
      }
    });
  });

  const updated = await prisma.ilinkBotQrSession.update({
    where: { id: sessionId },
    data: {
      status: "confirmed",
      botId: bot.id,
      lastError: null
    }
  });
  return withQrSvg(updated);
}

export async function getIlinkBot(botId: string) {
  return prisma.ilinkBotState.findUnique({
    where: { id: botId }
  });
}

export async function refreshIlinkLoginStatus(botId: string) {
  const bot = await requireIlinkBot(botId);
  if (!bot.qrcode) {
    return bot;
  }

  const data = await ilinkGet("/ilink/bot/get_qrcode_status", {
    qrcode: bot.qrcode
  });
  const status = normalizeLoginStatus(data.status);
  return prisma.ilinkBotState.update({
    where: { id: botId },
    data: {
      status,
      botToken: data.bot_token || data.token || bot.botToken,
      ilinkBotId: data.ilink_bot_id || bot.ilinkBotId,
      ilinkUserId: data.ilink_user_id || bot.ilinkUserId,
      baseUrl: data.baseurl || bot.baseUrl || config.ilinkBaseUrl,
      loggedInAt: status === "online" ? new Date() : bot.loggedInAt,
      lastError: data.errmsg || null
    }
  });
}

export async function pollIlinkUpdates(botId: string) {
  const bot = await requireIlinkBot(botId);
  if (!bot.botToken) {
    throw new Error("微信机器人尚未接入，请先生成二维码并扫码。");
  }

  const data = await ilinkPost(
    bot.baseUrl || config.ilinkBaseUrl,
    "/ilink/bot/getupdates",
    {
      get_updates_buf: bot.updatesBuf || "",
      base_info: { channel_version: config.ilinkChannelVersion }
    },
    bot.botToken
  );
  const updates = (data.updates || data.messages || data.msgs || []) as IlinkMessage[];
  let handledCount = 0;
  let skippedCount = 0;

  for (const message of updates) {
    try {
      if (!isInboundUserTextMessage(message)) {
        skippedCount += 1;
        continue;
      }

      const externalUserId = extractUserId(message);
      if (!externalUserId || !message.context_token) {
        skippedCount += 1;
        continue;
      }
      const senderName = extractSenderDisplayName(message, externalUserId);
      await persistIlinkConversationToken({
        wechatUserId: externalUserId,
        memberName: senderName,
        botId: bot.id,
        contextToken: message.context_token
      });
      // 有稳定 msgid 时先去重，再执行带重副作用的媒体提取（下载、归档、视觉识别），
      // 避免重复轮询到同一条消息时重复归档媒体、重复调用视觉模型。
      const stableMessageId = message.msgid || message.msg_id;
      if (stableMessageId && !(await tryMarkMessageProcessing(bot.id, stableMessageId))) {
        skippedCount += 1;
        continue;
      }
      const extracted = await extractMessageContent(message, {
        wechatUserId: externalUserId,
        memberName: senderName,
        sourceMessageId: extractMessageId(message)
      });
      const text = extracted.text;
      if (!stableMessageId) {
        const fallbackMessageId = extractMessageId(message, externalUserId, text);
        if (!(await tryMarkMessageProcessing(bot.id, fallbackMessageId))) {
          skippedCount += 1;
          continue;
        }
      }

      const reply = await dispatchBotMessage({
        platform: "wechat",
        externalUserId,
        displayName: senderName,
        text,
        media: extracted.media,
        raw: message
      });
      const mediaResults = await sendIlinkOutgoingMedia({
        botToken: bot.botToken,
        baseUrl: bot.baseUrl || config.ilinkBaseUrl,
        ilinkBotId: bot.ilinkBotId,
        toUserId: externalUserId,
        contextToken: message.context_token,
        media: reply.outgoingMedia || []
      });
      const finalContent = buildIlinkFinalReply(reply.content || "我收到你的消息了。", reply.outgoingMedia || [], mediaResults);
      const sendResult = await sendIlinkTextMessage({
        botToken: bot.botToken,
        baseUrl: bot.baseUrl || config.ilinkBaseUrl,
        ilinkBotId: bot.ilinkBotId,
        toUserId: externalUserId,
        contextToken: message.context_token,
        content: finalContent
      });
      console.log(
        `iLink reply sent to ${externalUserId}: ${truncateLog(finalContent)} result=${formatIlinkResult(sendResult)} media=${mediaResults.sent.length} failed=${mediaResults.failed.length}`
      );
      handledCount += 1;
    } catch (error) {
      console.error("Failed to handle iLink message", error);
      skippedCount += 1;
    }
  }

  const updated = await prisma.ilinkBotState.update({
    where: { id: botId },
    data: {
      status: "online",
      updatesBuf: data.get_updates_buf || data.next_buf || data.buf || bot.updatesBuf,
      pollingAt: new Date(),
      lastError: null
    }
  });

  return { bot: updated, updatesCount: updates.length, handledCount, skippedCount };
}

async function sendIlinkOutgoingMedia(input: {
  botToken: string;
  baseUrl: string;
  ilinkBotId?: string | null;
  toUserId: string;
  contextToken: string;
  media: OutgoingMedia[];
}) {
  const sent: IlinkResponse[] = [];
  const failed: Array<{ item: OutgoingMedia; error: unknown }> = [];
  for (const item of input.media) {
    const fileRef = item.filePath || item.publicUrl;
    if (!fileRef) {
      failed.push({ item, error: new Error("缺少文件路径。") });
      continue;
    }
    try {
      const result = await sendIlinkMediaMessage({
        ...input,
        item,
        fileRef
      });
      sent.push(result);
    } catch (error) {
      failed.push({ item, error });
      console.error("Failed to send iLink media", error);
    }
  }
  return { sent, failed };
}

function buildIlinkFinalReply(
  fallbackContent: string,
  media: OutgoingMedia[],
  result: { sent: IlinkResponse[]; failed: Array<{ item: OutgoingMedia; error: unknown }> }
) {
  if (!media.length) {
    return fallbackContent;
  }
  const generatedReportCount = media.filter((item) => item.source === "generated-report").length;
  const generatedDocumentCount = media.filter((item) => item.source === "generated-document").length;
  if (result.failed.length) {
    if (generatedReportCount) {
      return result.sent.length
        ? `项目汇报 Word 报告已发送 ${result.sent.length} 个，${result.failed.length} 个发送失败。`
        : "项目汇报 Word 报告已生成，但微信直发失败，请稍后重试。";
    }
    if (generatedDocumentCount) {
      return result.sent.length
        ? `Word 文档已发送 ${result.sent.length} 个，${result.failed.length} 个发送失败。`
        : "Word 文档已生成，但微信直发失败，请稍后重试。";
    }
    return result.sent.length
      ? `已发送 ${result.sent.length} 个文件，${result.failed.length} 个文件发送失败。`
      : "找到了文件，但微信直发失败，请稍后重试。";
  }
  if (generatedReportCount === 1 && result.sent.length === 1) {
    return "项目汇报 Word 报告已发送。";
  }
  if (generatedReportCount && result.sent.length > 1) {
    return `项目汇报 Word 报告已发送 ${result.sent.length} 个文件。`;
  }
  if (generatedDocumentCount === 1 && result.sent.length === 1) {
    return "Word 文档已发送。";
  }
  if (generatedDocumentCount && result.sent.length > 1) {
    return `Word 文档已发送 ${result.sent.length} 个文件。`;
  }
  if (result.sent.length === 1 && media[0]?.mediaType === "image") {
    return "找到了，已发送图片。";
  }
  if (result.sent.length === 1) {
    return "找到了，已发送文件。";
  }
  return `找到了，已发送 ${result.sent.length} 个文件。`;
}

export async function listPollableIlinkBots() {
  const bot = await prisma.ilinkBotState.findFirst({
    where: {
      botToken: { not: null },
      status: { not: "deleted" }
    },
    orderBy: [{ loggedInAt: "desc" }, { createdAt: "desc" }]
  });
  return bot ? [bot] : [];
}

export async function markIlinkBotPollingError(botId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return prisma.ilinkBotState.update({
    where: { id: botId },
    data: {
      lastError: message
    }
  });
}

export async function deleteIlinkBot(botId: string) {
  await prisma.ilinkBotState.update({
    where: { id: botId },
    data: {
      status: "deleted",
      botToken: null,
      lastError: "已在后台停用"
    }
  });
  return { ok: true };
}

export async function sendIlinkTextForBot(input: {
  botId?: string | null;
  toUserId: string;
  contextToken: string;
  content: string;
}): Promise<IlinkResponse>;
export async function sendIlinkTextForBot(
  toUserId: string,
  contextToken: string,
  content: string,
  botId?: string | null
): Promise<IlinkResponse>;
export async function sendIlinkTextForBot(
  inputOrToUserId:
    | {
        botId?: string | null;
        toUserId: string;
        contextToken: string;
        content: string;
      }
    | string,
  contextToken?: string,
  content?: string,
  botId?: string | null
) {
  const input =
    typeof inputOrToUserId === "string"
      ? {
          botId,
          toUserId: inputOrToUserId,
          contextToken: contextToken || "",
          content: content || ""
        }
      : inputOrToUserId;
  const bot = input.botId ? await requireIlinkBot(input.botId) : await getCurrentIlinkBot();
  if (!bot) {
    throw new Error("机器人不存在。");
  }
  if (!bot.botToken) {
    throw new Error("微信机器人尚未接入，请先生成二维码并扫码。");
  }
  return sendIlinkTextMessage({
    botToken: bot.botToken,
    baseUrl: bot.baseUrl || config.ilinkBaseUrl,
    ilinkBotId: bot.ilinkBotId,
    toUserId: input.toUserId,
    contextToken: input.contextToken,
    content: input.content
  });
}

export async function sendIlinkImageForBot(input: {
  botId: string;
  toUserId: string;
  contextToken: string;
  fileRef: string;
}) {
  const bot = await requireIlinkBot(input.botId);
  if (!bot.botToken) {
    throw new Error("微信机器人尚未接入，请先生成二维码并扫码。");
  }
  return sendIlinkImageMessage({
    botToken: bot.botToken,
    baseUrl: bot.baseUrl || config.ilinkBaseUrl,
    ilinkBotId: bot.ilinkBotId,
    toUserId: input.toUserId,
    contextToken: input.contextToken,
    fileRef: input.fileRef
  });
}

export async function sendIlinkMediaForBot(input: {
  botId: string;
  toUserId: string;
  contextToken: string;
  item: OutgoingMedia;
}) {
  const bot = await requireIlinkBot(input.botId);
  if (!bot.botToken) {
    throw new Error("微信机器人尚未接入，请先生成二维码并扫码。");
  }
  const fileRef = input.item.filePath || input.item.publicUrl;
  if (!fileRef) {
    throw new Error("待发送文件缺少 filePath/publicUrl。");
  }
  return sendIlinkMediaMessage({
    botToken: bot.botToken,
    baseUrl: bot.baseUrl || config.ilinkBaseUrl,
    ilinkBotId: bot.ilinkBotId,
    toUserId: input.toUserId,
    contextToken: input.contextToken,
    item: input.item,
    fileRef
  });
}

async function sendIlinkMediaMessage(input: {
  botToken: string;
  baseUrl: string;
  ilinkBotId?: string | null;
  toUserId: string;
  contextToken: string;
  item: OutgoingMedia;
  fileRef: string;
}) {
  if (input.item.mediaType === "image") {
    return sendIlinkImageMessage(input);
  }
  return sendIlinkGenericMediaMessage(input);
}

async function sendIlinkTextMessage(input: {
  botToken: string;
  baseUrl: string;
  ilinkBotId?: string | null;
  toUserId: string;
  contextToken: string;
  content: string;
}) {
  if (!input.toUserId) {
    throw new Error("iLink 入站消息缺少 from_user_id，无法回复。");
  }
  return ilinkPost(
    input.baseUrl,
    "/ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: input.ilinkBotId || undefined,
        to_user_id: input.toUserId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: input.contextToken,
        item_list: [{ type: 1, text_item: { text: input.content } }]
      }
    },
    input.botToken
  );
}

async function sendIlinkImageMessage(input: {
  botToken: string;
  baseUrl: string;
  ilinkBotId?: string | null;
  toUserId: string;
  contextToken: string;
  fileRef: string;
}) {
  const raw = await readMediaBytes(input.fileRef);
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const encrypted = encryptIlinkMedia(raw, aesKey);
  const rawMd5 = crypto.createHash("md5").update(raw).digest("hex");
  const filekey = crypto.randomBytes(16).toString("hex");

  const uploadData = await ilinkPost(
    input.baseUrl,
    "/ilink/bot/getuploadurl",
    {
      filekey,
      media_type: 1,
      to_user_id: input.toUserId,
      rawsize: raw.byteLength,
      rawfilemd5: rawMd5,
      filesize: encrypted.byteLength,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: {}
    },
    input.botToken
  );

  let uploadUrl = String(uploadData.upload_full_url || "").trim();
  if (!uploadUrl) {
    if (!uploadData.upload_param) {
      throw new Error("iLink 未返回图片上传地址。");
    }
    uploadUrl = `${config.ilinkCdnBase}/upload?encrypted_query_param=${encodeURIComponent(String(uploadData.upload_param))}&filekey=${encodeURIComponent(filekey)}`;
  }

  const cdnResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: encrypted,
    signal: AbortSignal.timeout(30000)
  });
  if (!cdnResponse.ok) {
    const text = await cdnResponse.text().catch(() => "");
    throw new Error(`CDN upload failed: ${cdnResponse.status} ${text.slice(0, 160)}`);
  }

  const downloadParam = cdnResponse.headers.get("X-Encrypted-Param");
  if (!downloadParam) {
    throw new Error("CDN 上传响应缺少 X-Encrypted-Param。");
  }

  const aesKeyBase64 = Buffer.from(aesKeyHex).toString("base64");
  return ilinkPost(
    input.baseUrl,
    "/ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: input.ilinkBotId || "",
        to_user_id: input.toUserId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: input.contextToken,
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: aesKeyBase64,
                encrypt_type: 1
              },
              mid_size: encrypted.byteLength
            }
          }
        ]
      }
    },
    input.botToken
  );
}

async function sendIlinkGenericMediaMessage(input: {
  botToken: string;
  baseUrl: string;
  ilinkBotId?: string | null;
  toUserId: string;
  contextToken: string;
  item: OutgoingMedia;
  fileRef: string;
}) {
  const upload = await uploadIlinkMedia({
    botToken: input.botToken,
    baseUrl: input.baseUrl,
    toUserId: input.toUserId,
    fileRef: input.fileRef,
    mediaType: resolveIlinkUploadMediaType(input.item.mediaType)
  });
  const media = {
    encrypt_query_param: upload.downloadParam,
    aes_key: upload.aesKeyBase64,
    encrypt_type: 1
  };
  const fileName = input.item.fileName || input.fileRef.split(/[\\/]/).pop() || "file";
  const itemListEntry =
    input.item.mediaType === "voice"
      ? {
          type: 3,
          voice_item: {
            media,
            mid_size: upload.encryptedSize,
            voice_size: upload.rawSize
          }
        }
      : input.item.mediaType === "video"
        ? {
            type: 5,
            video_item: {
              media,
              mid_size: upload.encryptedSize,
              video_size: upload.rawSize,
              file_name: fileName
            }
          }
        : {
            type: 4,
            file_item: {
              media: {
                ...media,
                full_url: `${config.ilinkCdnBase}/download?encrypted_query_param=${encodeURIComponent(upload.downloadParam)}`
              },
              file_name: fileName,
              file_size: upload.rawSize,
              mid_size: upload.encryptedSize
            }
          };

  return ilinkPost(
    input.baseUrl,
    "/ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: input.ilinkBotId || "",
        to_user_id: input.toUserId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: input.contextToken,
        item_list: [itemListEntry]
      }
    },
    input.botToken
  );
}

async function uploadIlinkMedia(input: {
  botToken: string;
  baseUrl: string;
  toUserId: string;
  fileRef: string;
  mediaType: number;
}) {
  const raw = await readMediaBytes(input.fileRef);
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const encrypted = encryptIlinkMedia(raw, aesKey);
  const rawMd5 = crypto.createHash("md5").update(raw).digest("hex");
  const filekey = crypto.randomBytes(16).toString("hex");

  const uploadData = await ilinkPost(
    input.baseUrl,
    "/ilink/bot/getuploadurl",
    {
      filekey,
      media_type: input.mediaType,
      to_user_id: input.toUserId,
      rawsize: raw.byteLength,
      rawfilemd5: rawMd5,
      filesize: encrypted.byteLength,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: {}
    },
    input.botToken
  );
  let uploadUrl = String(uploadData.upload_full_url || "").trim();
  if (!uploadUrl) {
    if (!uploadData.upload_param) {
      throw new Error(`iLink 未返回媒体上传地址：media_type=${input.mediaType}`);
    }
    uploadUrl = `${config.ilinkCdnBase}/upload?encrypted_query_param=${encodeURIComponent(String(uploadData.upload_param))}&filekey=${encodeURIComponent(filekey)}`;
  }

  const cdnResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: encrypted,
    signal: AbortSignal.timeout(30000)
  });
  if (!cdnResponse.ok) {
    const text = await cdnResponse.text().catch(() => "");
    throw new Error(`CDN upload failed: ${cdnResponse.status} ${text.slice(0, 160)}`);
  }

  const downloadParam = cdnResponse.headers.get("X-Encrypted-Param");
  if (!downloadParam) {
    throw new Error("CDN 上传响应缺少 X-Encrypted-Param。");
  }

  return {
    downloadParam,
    aesKeyBase64: Buffer.from(aesKeyHex).toString("base64"),
    rawSize: raw.byteLength,
    encryptedSize: encrypted.byteLength
  };
}

function resolveIlinkUploadMediaType(mediaType: OutgoingMedia["mediaType"]) {
  switch (mediaType) {
    case "image":
      return 1;
    case "voice":
      return 2;
    case "video":
      return 3;
    case "file":
    default:
      return 3;
  }
}

async function readMediaBytes(fileRef: string) {
  if (/^https?:\/\//i.test(fileRef)) {
    const response = await fetch(fileRef, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`读取远程媒体失败：${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return fsReadFile(fileRef);
}

async function fsReadFile(filePath: string) {
  const fs = await import("node:fs/promises");
  return fs.readFile(filePath);
}

function encryptIlinkMedia(raw: Buffer, aesKey: Buffer) {
  const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(raw), cipher.final()]);
}

function truncateLog(content: string) {
  return content.replace(/\s+/g, " ").slice(0, 120);
}

function formatIlinkResult(data: IlinkResponse) {
  return JSON.stringify({
    retcode: data.retcode,
    ret: data.ret,
    errmsg: data.errmsg,
    msg: data.msg
  });
}

function formatIlinkInboundItemShape(item: NonNullable<IlinkMessage["item_list"]>[number]) {
  const mediaItem = item.image_item || item.voice_item || item.file_item || item.video_item;
  return JSON.stringify({
    type: item.type,
    itemKeys: Object.keys(item),
    mediaItemKeys: mediaItem ? Object.keys(mediaItem) : [],
    mediaKeys: mediaItem?.media ? Object.keys(mediaItem.media) : [],
    fileName: item.file_item?.file_name,
    fileSize: item.file_item?.file_size
  });
}

async function requireIlinkBot(botId: string) {
  const bot = await getIlinkBot(botId);
  if (!bot) {
    throw new Error("机器人不存在。");
  }
  return bot;
}

async function persistIlinkConversationToken(input: {
  wechatUserId: string;
  memberName?: string;
  botId: string;
  contextToken: string;
}) {
  try {
    const user = await ensureWechatUser(input.wechatUserId, input.memberName);
    await prisma.wechatConversationState.upsert({
      where: { wechatUserId: input.wechatUserId },
      create: {
        wechatUserId: input.wechatUserId,
        userId: user.id,
        lastContextToken: input.contextToken,
        lastIlinkBotId: input.botId,
        lastInboundAt: new Date()
      },
      update: {
        userId: user.id,
        lastContextToken: input.contextToken,
        lastIlinkBotId: input.botId,
        lastInboundAt: new Date()
      }
    });
  } catch (error) {
    console.warn("Failed to persist iLink conversation token", error);
  }
}

async function getCurrentIlinkBot() {
  return prisma.ilinkBotState.findFirst({
    where: {
      status: { not: "deleted" }
    },
    orderBy: [{ loggedInAt: "desc" }, { createdAt: "desc" }]
  });
}

async function ilinkGet(pathname: string, query: Record<string, string>) {
  const url = new URL(`${config.ilinkBaseUrl.replace(/\/$/, "")}${pathname}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: ilinkHeaders(), signal: AbortSignal.timeout(20000) });
  return parseIlinkResponse(response);
}

async function ilinkPost(baseUrl: string, pathname: string, body: unknown, botToken?: string) {
  if (!baseUrl) {
    throw new Error("ILINK_BASE_URL 未配置：请在 .env 中填写 iLink 平台参数后重启（见 .env.example）。");
  }
  const url = `${baseUrl.replace(/\/$/, "")}${pathname}`;
  const response = await fetch(url, {
    method: "POST",
    headers: ilinkHeaders(botToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000)
  });
  return parseIlinkResponse(response);
}

async function parseIlinkResponse(response: Response) {
  const text = await response.text();
  let data: IlinkResponse;
  try {
    data = JSON.parse(text) as IlinkResponse;
  } catch {
    throw new Error(`iLink 返回非 JSON 响应：HTTP ${response.status} ${text.slice(0, 240)}`);
  }

  const ret = typeof data.retcode === "number" ? data.retcode : data.ret;
  if (!response.ok || (typeof ret === "number" && ret !== 0)) {
    throw new Error(data.errmsg || data.msg || `iLink request failed: ${response.status}`);
  }
  return data;
}

function ilinkHeaders(botToken?: string) {
  const bearerToken = botToken || config.ilinkApiKey;
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 4_294_967_295))).toString("base64"),
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
  };
}

function normalizeLoginStatus(status: unknown) {
  if (
    status === 1 ||
    status === "1" ||
    status === "online" ||
    status === "confirmed" ||
    status === "login_success"
  ) {
    return "online";
  }
  if (status === 2 || status === "2" || status === "expired") {
    return "expired";
  }
  if (status === "scanned") {
    return "scanned";
  }
  return "waiting_scan";
}

function isInboundUserTextMessage(message: IlinkMessage) {
  const messageType = message.message_type ?? message.msg_type;
  if (messageType !== undefined && String(messageType) !== "1" && !message.item_list?.length) {
    return false;
  }
  if (!message.context_token) {
    return false;
  }
  return Boolean((message.item_list?.length || extractMessageText(message)) && extractUserId(message));
}

export async function extractMessageContent(
  message: IlinkMessage,
  input: {
    wechatUserId?: string;
    memberName?: string;
    sourceMessageId?: string;
  }
) {
  const parts: string[] = [];
  const media: Array<{
    id?: string;
    mediaType: string;
    fileName: string;
    filePath: string;
    publicUrl: string;
    caption?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
  }> = [];

  let hasMediaItem = false;
  for (const item of message.item_list || []) {
    if (item.type !== 1) {
      console.log(`iLink inbound media shape ${formatIlinkInboundItemShape(item)}`);
      hasMediaItem = true;
    }
    switch (item.type) {
      case 1:
        if (item.text_item?.text) {
          parts.push(item.text_item.text);
        }
        break;
      case 2:
        await captureMedia({
          mediaType: "image",
          mediaItem: item.image_item,
          textLabel: "图片",
          input,
          media,
          parts
        });
        break;
      case 3: {
        const voiceText = item.voice_item?.voice_text || item.voice_item?.text;
        if (voiceText) {
          parts.push(voiceText);
        }
        await captureMedia({
          mediaType: "voice",
          mediaItem: item.voice_item,
          textLabel: "语音",
          input,
          media,
          parts,
          appendVoiceTranscript: !voiceText
        });
        break;
      }
      case 4:
        await captureMedia({
          mediaType: "file",
          mediaItem: item.file_item,
          fileName: extractIlinkFileName(item.file_item),
          textLabel: extractIlinkFileName(item.file_item) || "文件",
          input,
          media,
          parts
        });
        break;
      case 5:
        await captureMedia({
          mediaType: "video",
          mediaItem: item.video_item,
          textLabel: "视频",
          input,
          media,
          parts
        });
        break;
    }
  }

  // 信封文本只给纯文本消息垫底；含媒体条目的消息（语音/图片/文件/视频）
  // 一旦 parts 为空必须保持为空，让 media-only 守卫接管——
  // 否则平台信封的原始占位文本会被当成用户消息送进路由（历史 bug：语音乱发文件）。
  const fallbackText = extractMessageText(message);
  if (!parts.length && fallbackText && !hasMediaItem) {
    parts.push(fallbackText);
  }

  return {
    text: parts.join("\n").trim(),
    media
  };
}

async function captureMedia(input: {
  mediaType: MediaType;
  mediaItem?: IlinkMediaItem;
  fileName?: string;
  textLabel: string;
  input: {
    wechatUserId?: string;
    memberName?: string;
    sourceMessageId?: string;
  };
  media: Array<{
    id?: string;
    mediaType: string;
    fileName: string;
    filePath: string;
    publicUrl: string;
    caption?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
  }>;
  parts: string[];
  appendVoiceTranscript?: boolean;
}) {
  if (!hasDownloadableMedia(input.mediaItem) || !input.input.wechatUserId) {
    if (input.mediaType !== "voice") {
      input.parts.push(`[${input.textLabel}]`);
    }
    return;
  }

  try {
    const bytes = await downloadIlinkMediaItem(input.mediaItem);
    const stored = await persistMedia({
      bytes,
      mediaType: input.mediaType,
      fileName: input.fileName
    });
    const voiceCaption =
      input.mediaType === "voice"
        ? await describeVoiceMedia({
            bytes,
            fileName: stored.fileName,
            mimeType: stored.mimeType
          })
        : null;
    const metadata = {
      label: input.textLabel,
      ...(voiceCaption ? { fullCaption: voiceCaption } : {})
    };
    const record = await createMediaRecord({
      wechatUserId: input.input.wechatUserId,
      memberName: input.input.memberName,
      mediaType: input.mediaType,
      fileName: stored.fileName,
      filePath: stored.filePath,
      publicUrl: stored.publicUrl,
      mimeType: stored.mimeType,
      fileSize: stored.fileSize,
      sourceMessageId: input.input.sourceMessageId,
      caption: voiceCaption || undefined,
      metadata
    });
    const indexedRecord =
      record.mediaType === "image"
        ? await recognizeAndIndexImageMedia(record.id).catch((error) => {
            console.error("Failed to index image media", error);
            return record;
          })
        : record;
    input.media.push({
      id: indexedRecord?.id || record.id,
      mediaType: indexedRecord?.mediaType || record.mediaType,
      fileName: indexedRecord?.fileName || record.fileName,
      filePath: indexedRecord?.filePath || record.filePath,
      publicUrl: indexedRecord?.publicUrl || record.publicUrl,
      caption: indexedRecord?.caption || null,
      mimeType: indexedRecord?.mimeType || record.mimeType,
      fileSize: indexedRecord?.fileSize || record.fileSize
    });
    if (input.mediaType === "voice" && input.appendVoiceTranscript && voiceCaption) {
      input.parts.push(voiceCaption);
    }
  } catch (error) {
    if (input.mediaType !== "voice") {
      const message = error instanceof Error ? error.message : "未知错误";
      input.parts.push(`[${input.textLabel}下载失败: ${message}]`);
    }
  }
}

async function downloadIlinkMediaItem(mediaItem?: IlinkMediaItem) {
  const queryParam = extractIlinkMediaQueryParam(mediaItem);
  const aesKeyHex = extractIlinkAesKeyHex(mediaItem);
  if (queryParam && aesKeyHex) {
    return downloadIlinkMedia(queryParam, aesKeyHex);
  }

  const fullUrl = extractIlinkFullUrl(mediaItem);
  if (!fullUrl) {
    throw new Error("缺少媒体下载参数。");
  }
  const response = await fetch(fullUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`CDN direct download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function hasDownloadableMedia(mediaItem?: IlinkMediaItem) {
  return Boolean((extractIlinkMediaQueryParam(mediaItem) && extractIlinkAesKeyHex(mediaItem)) || extractIlinkFullUrl(mediaItem));
}

async function downloadIlinkMedia(encryptQueryParam: string, aesKeyHex: string) {
  if (!config.ilinkCdnBase) {
    throw new Error("ILINK_CDN_BASE 未配置：请在 .env 中填写 iLink 平台参数（见 .env.example）。");
  }
  const url = `${config.ilinkCdnBase}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`CDN download failed: ${response.status}`);
  }
  const encrypted = Buffer.from(await response.arrayBuffer());
  const key = Buffer.from(aesKeyHex, "hex");
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function extractIlinkMediaQueryParam(mediaItem?: IlinkMediaItem) {
  const raw = (mediaItem || {}) as Record<string, unknown>;
  return firstString(
    mediaItem?.media?.encrypt_query_param,
    mediaItem?.encrypt_query_param,
    valueFromPath(raw, ["cdn", "encrypt_query_param"]),
    valueFromPath(raw, ["download", "encrypt_query_param"])
  );
}

function extractIlinkFullUrl(mediaItem?: IlinkMediaItem) {
  const raw = (mediaItem || {}) as Record<string, unknown>;
  return firstString(
    mediaItem?.media?.full_url,
    mediaItem?.full_url,
    mediaItem?.download_url,
    mediaItem?.file_url,
    mediaItem?.url,
    valueFromPath(raw, ["cdn", "full_url"]),
    valueFromPath(raw, ["download", "url"]),
    valueFromPath(raw, ["file", "url"])
  );
}

function extractIlinkAesKeyHex(mediaItem?: IlinkMediaItem) {
  return resolveAesKeyHex(
    mediaItem?.aeskey || mediaItem?.aes_key,
    mediaItem?.media?.aes_key || firstString(valueFromPath((mediaItem || {}) as Record<string, unknown>, ["media", "aeskey"]))
  );
}

function extractIlinkFileName(fileItem?: IlinkMediaItem & { file_name?: string }) {
  const raw = (fileItem || {}) as Record<string, unknown>;
  return firstString(
    fileItem?.file_name,
    valueFromPath(raw, ["file", "name"]),
    valueFromPath(raw, ["file", "file_name"]),
    valueFromPath(raw, ["appmsg", "title"]),
    valueFromPath(raw, ["title"])
  );
}

function firstString(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find(Boolean);
}

function resolveAesKeyHex(itemKey?: string, mediaKey?: string) {
  if (itemKey) {
    return itemKey;
  }
  if (!mediaKey) {
    return null;
  }
  return Buffer.from(mediaKey, "base64").toString("utf8");
}

function extractMessageText(message: IlinkMessage) {
  const firstItem = message.item_list?.[0];
  return String(
    firstItem?.text_item?.text ||
      firstItem?.voice_item?.text ||
      firstItem?.voice_item?.voice_text ||
      message.content ||
      message.text ||
      ""
  ).trim();
}

function extractUserId(message: IlinkMessage) {
  return (
    message.from_user_id ||
    message.from_user_name ||
    message.from_username ||
    message.from_wxid ||
    message.sender
  );
}

function extractSenderDisplayName(message: IlinkMessage, userId?: string) {
  const raw = message as IlinkMessage & Record<string, unknown>;
  const candidates = [
    message.nickname,
    message.from_nickname,
    message.sender_nickname,
    message.sender_name,
    message.display_name,
    message.remark_name,
    message.alias,
    valueFromPath(raw, ["sender_info", "nickname"]),
    valueFromPath(raw, ["sender_info", "display_name"]),
    valueFromPath(raw, ["sender_info", "remark_name"]),
    valueFromPath(raw, ["from_user", "nickname"]),
    valueFromPath(raw, ["from_user", "display_name"]),
    valueFromPath(raw, ["contact", "nickname"]),
    valueFromPath(raw, ["contact", "remark_name"]),
    message.from_user_name,
    message.from_username
  ]
    .map((value) => value?.trim())
    .filter(Boolean) as string[];
  const usable = candidates.find((value) => value !== userId && !value.includes("@im.wechat") && value !== "微信机器人");
  if (usable) {
    return usable;
  }
  return buildWechatMemberFallbackName(userId);
}

function valueFromPath(value: Record<string, unknown>, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function buildWechatMemberFallbackName(userId?: string) {
  if (!userId) {
    return "微信用户";
  }
  const prefix = userId.split("@")[0]?.slice(0, 8);
  return prefix ? `微信用户${prefix}` : "微信用户";
}

function extractMessageId(message: IlinkMessage, userId?: string, text?: string) {
  return message.msgid || message.msg_id || `${userId || "unknown"}:${message.context_token || "no-context"}:${text || ""}`;
}

async function tryMarkMessageProcessing(botId: string, messageId: string) {
  return prisma.ilinkProcessedMessage
    .create({
      data: {
        botId,
        messageId
      }
    })
    .then(() => true)
    .catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        return false;
      }
      throw error;
    });
}

async function withQrSvg<T extends IlinkBotQrSession | IlinkBotState>(item: T) {
  const qrValue = item.qrcodeContent || item.qrcode;
  if (!qrValue) {
    return { ...item, qrSvg: null };
  }
  const qrSvg = await QRCode.toString(qrValue, {
    type: "svg",
    margin: 1,
    width: 260
  });
  return { ...item, qrSvg };
}
