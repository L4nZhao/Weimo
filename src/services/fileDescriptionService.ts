const MAX_DESCRIPTION_LENGTH = 120;

export function summarizeFileDescription(input: {
  fileName?: string | null;
  mediaType?: string | null;
  text?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const metadataText = extractMetadataText(input.metadata);
  const raw = [input.text, metadataText, input.fileName].filter(Boolean).join("\n");
  const normalized = normalizeDescriptionText(raw);
  if (!normalized) {
    return fallbackDescription(input.fileName, input.mediaType);
  }

  const sentences = splitSentences(normalized);
  const selected = sentences.find((sentence) => sentence.length >= 12) || sentences[0] || normalized;
  return trimDescription(selected);
}

export function normalizeDescriptionText(value: string) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/storage\/\S+/gi, "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/[#*_`>\[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(value: string) {
  return value
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimDescription(value: string) {
  const text = normalizeDescriptionText(value);
  if (text.length <= MAX_DESCRIPTION_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trim()}…`;
}

function extractMetadataText(metadata?: Record<string, unknown> | null) {
  if (!metadata) {
    return "";
  }
  const fields = ["summary", "description", "caption", "title", "prompt", "label", "projectName", "templateName", "keywords"];
  return fields
    .map((field) => metadata[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

function fallbackDescription(fileName?: string | null, mediaType?: string | null) {
  const typeName =
    {
      image: "图片文件",
      file: "文档文件",
      voice: "语音文件",
      video: "视频文件"
    }[String(mediaType || "")] || "系统文件";
  return fileName ? `${typeName}：${fileName}` : typeName;
}
