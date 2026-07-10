import { appendChatMessage } from "./chatHistoryService.js";
import { runAgent } from "./agentService.js";
import { autoStoreMemory } from "./memoryService.js";
import { ensureWechatUser } from "./userService.js";
import type { OutgoingMedia } from "./skillTypes.js";

export type WechatReply = {
  type: "text";
  content: string;
  outgoingMedia?: OutgoingMedia[];
};

export async function handleWechatMessage(input: {
  wechatUserId: string;
  memberName?: string;
  content: string;
  media?: Array<{
    mediaType: string;
    fileName: string;
    publicUrl: string;
    caption?: string | null;
  }>;
}): Promise<WechatReply> {
  const content = input.content.trim();
  const user = await ensureWechatUser(input.wechatUserId, input.memberName);
  const media = input.media || [];

  if (!content && !media.length) {
    return {
      type: "text",
      content: "我收到了空消息。"
    };
  }

  if (!content && media.length) {
    const captions = media
      .filter((item) => item.mediaType === "image" && item.caption)
      .map((item, index) => `${index + 1}. ${item.caption}`);
    const imageCount = media.filter((item) => item.mediaType === "image").length;
    const fileCount = media.length - imageCount;
    const savedText = [`已收到并存档，共 ${media.length} 个文件。`];
    if (captions.length) {
      savedText.push(`图片识别结果：\n${captions.join("\n")}`);
      savedText.push("稍后可用文字描述搜索，也可以让我记住这张图片代表的事项。");
    } else if (imageCount) {
      savedText.push("图片会自动识别，稍后可用文字描述搜索。");
    } else if (fileCount) {
      savedText.push("稍后可按文件名或描述搜索并让我转发。");
    }
    return {
      type: "text",
      content: savedText.join("\n")
    };
  }

  const agentMessage = media.length ? `${content}\n\n${formatMediaForAgent(media)}` : content;

  await appendChatMessage({
    wechatUserId: input.wechatUserId,
    memberName: input.memberName,
    role: "user",
    content: agentMessage
  });
  void autoStoreMemory({
    wechatUserId: input.wechatUserId,
    memberName: input.memberName,
    content: agentMessage
  });

  const reply = await runAgent({
    wechatUserId: input.wechatUserId,
    userId: user.id,
    memberName: user.name,
    message: agentMessage
  });

  await appendChatMessage({
    wechatUserId: input.wechatUserId,
    memberName: input.memberName,
    role: "assistant",
    content: reply.content
  });

  return {
    type: "text",
    content: reply.content,
    outgoingMedia: reply.outgoingMedia
  };
}

function formatMediaForAgent(
  media: Array<{
    mediaType: string;
    fileName: string;
    publicUrl: string;
    caption?: string | null;
  }>
) {
  return [
    "用户随消息发送了以下媒体文件：",
    ...media.map((item, index) =>
      [
        `${index + 1}. ${item.mediaType} ${item.fileName}: ${item.publicUrl}`,
        item.caption ? `   图片识别：${item.caption}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    )
  ].join("\n");
}
