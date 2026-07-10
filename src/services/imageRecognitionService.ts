import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../lib/config.js";
import { getSharedVisionOpenAI } from "../lib/openaiClient.js";

const client = getSharedVisionOpenAI();

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
};

export function hasImageRecognition() {
  return Boolean(client);
}

export async function recognizeImage(filePath: string) {
  if (!client) {
    return null;
  }

  try {
    const bytes = await fs.readFile(filePath);
    const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "image/jpeg";
    const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    const completion = await client.chat.completions.create({
      model: config.visionModel,
      messages: [
        {
          role: "system",
          content:
            "用中文简要描述这张图片的内容，包括主体、场景、文字、颜色、布局、风格等关键信息。只输出描述，不要输出 Markdown。"
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请识别并描述这张图片，重点提取画面内容和可见文字。"
            },
            {
              type: "image_url",
              image_url: { url: dataUri }
            }
          ]
        }
      ],
      temperature: 0.2
    });

    return completion.choices[0]?.message.content?.trim() || null;
  } catch (error) {
    console.error("Image recognition failed", error);
    return null;
  }
}
