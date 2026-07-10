import { handleWechatMessage } from "./wechatService.js";

export type BotMessage = {
  platform: "wechat";
  externalUserId: string;
  displayName?: string;
  text: string;
  media?: Array<{
    id?: string;
    mediaType: string;
    fileName: string;
    filePath: string;
    publicUrl: string;
    mimeType?: string | null;
    fileSize?: number | null;
  }>;
  raw?: unknown;
};

export async function dispatchBotMessage(message: BotMessage) {
  return handleWechatMessage({
    wechatUserId: message.externalUserId,
    memberName: message.displayName,
    content: message.text,
    media: message.media
  });
}
