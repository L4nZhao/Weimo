import "dotenv/config";
import { randomSecret } from "./security.js";

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";
const sessionSecret = process.env.SESSION_SECRET || (isProduction ? "" : randomSecret());
const fileAccessSecret = process.env.FILE_ACCESS_SECRET || sessionSecret;
const adminUsername = process.env.ADMIN_USERNAME || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const adminCookieSecure = parseBoolean(process.env.ADMIN_COOKIE_SECURE) ?? publicBaseUrl.startsWith("https://");

validateProductionConfig();

export const config = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl,
  storageRoot: process.env.STORAGE_ROOT,
  allowedOrigins: parseList(process.env.ADMIN_ALLOWED_ORIGINS),
  adminUsername,
  adminPassword,
  adminCookieSecure,
  sessionSecret,
  fileAccessSecret,
  signedFileUrlTtlSeconds: Number(process.env.SIGNED_FILE_URL_TTL_SECONDS || 10 * 60),
  webhookSecret: process.env.WEBHOOK_SECRET,
  requireWebhookSignature: process.env.REQUIRE_WEBHOOK_SIGNATURE === "true" || isProduction,
  wechatBindBaseUrl: process.env.WECHAT_BIND_BASE_URL || process.env.PUBLIC_BASE_URL || "http://localhost:3000",
  ilinkBaseUrl: process.env.ILINK_BASE_URL || "",
  ilinkCdnBase: process.env.ILINK_CDN_BASE || "",
  ilinkApiKey: process.env.ILINK_API_KEY,
  ilinkAutoPoll: process.env.ILINK_AUTO_POLL !== "false",
  ilinkPollRetryMs: Number(process.env.ILINK_POLL_RETRY_MS || 3000),
  ilinkChannelVersion: process.env.ILINK_CHANNEL_VERSION || "",
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY,
  dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  dashscopeEmbeddingModel: process.env.DASHSCOPE_EMBEDDING_MODEL || "text-embedding-v4",
  tavilyApiKey: process.env.TAVILY_API_KEY,
  openaiApiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
  openaiBaseUrl: process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL,
  openaiModel: process.env.LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  // 语音转写默认关闭：仅当显式配置 ASR_BASE_URL 时启用（当前 LLM 服务商不支持 /audio/transcriptions）
  asrBaseUrl: process.env.ASR_BASE_URL,
  asrApiKey: process.env.ASR_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
  visionApiKey: process.env.IMAGE_RECOGNITION_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
  visionBaseUrl:
    process.env.IMAGE_RECOGNITION_BASE_URL || process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL,
  visionModel: process.env.IMAGE_RECOGNITION_MODEL || process.env.LLM_VISION_MODEL || "qwen-vl-plus",
  agentMaxTurns: Number(process.env.AGENT_MAX_TURNS || 6),
  memoryAutoSaveMinLength: Number(process.env.MEMORY_AUTO_SAVE_MIN_LENGTH || 4)
};

function validateProductionConfig() {
  if (!isProduction) {
    return;
  }
  const problems: string[] = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "change-me-in-production") {
    problems.push("SESSION_SECRET must be set to a strong production secret.");
  }
  if (!process.env.FILE_ACCESS_SECRET) {
    problems.push("FILE_ACCESS_SECRET must be set for signed file access.");
  }
  if (!process.env.WEBHOOK_SECRET) {
    problems.push("WEBHOOK_SECRET must be set when NODE_ENV=production.");
  }
  if (adminPassword === "admin123") {
    problems.push("ADMIN_PASSWORD must not use the default password in production.");
  }
  if (adminUsername === "admin" && adminPassword === "admin123") {
    problems.push("ADMIN_USERNAME/ADMIN_PASSWORD must not both use default credentials in production.");
  }
  if (problems.length) {
    throw new Error(`Unsafe production configuration:\n- ${problems.join("\n- ")}`);
  }
}

function parseList(value?: string) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value?: string) {
  if (value === undefined) {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
