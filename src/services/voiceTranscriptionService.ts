import OpenAI, { toFile } from "openai";
import { config } from "../lib/config.js";
import { normalizeDescriptionText } from "./fileDescriptionService.js";

const DEFAULT_ASR_MODEL = "whisper-1";
const DEFAULT_TIMEOUT_MS = 15_000;

// 仅当显式配置了 ASR_BASE_URL 才创建 ASR 客户端；否则转写整体禁用
// （历史问题：主 LLM 服务商不支持 /audio/transcriptions，每条语音都 404）
const defaultAsrClient =
  config.asrBaseUrl && config.asrApiKey
    ? new OpenAI({
        apiKey: config.asrApiKey,
        baseURL: config.asrBaseUrl
      })
    : null;

type AsrClient = {
  audio?: {
    transcriptions?: {
      create: (body: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

type VoiceTranscriptionDependencies = {
  asrClient: AsrClient | null | undefined;
  asrModel: string | undefined;
  timeoutMs: number | undefined;
  transcribeAudio: ((input: VoiceTranscriptionInput) => Promise<string | null | undefined>) | undefined;
  logger: Pick<Console, "warn"> | null | undefined;
};

export type VoiceTranscriptionInput = {
  bytes: Uint8Array;
  fileName?: string | null;
  mimeType?: string | null;
};

const defaultDependencies: VoiceTranscriptionDependencies = {
  asrClient: undefined,
  asrModel: undefined,
  timeoutMs: undefined,
  transcribeAudio: undefined,
  logger: undefined
};

let dependencies: VoiceTranscriptionDependencies = { ...defaultDependencies };

export function setVoiceTranscriptionDependencies(overrides: Partial<VoiceTranscriptionDependencies>) {
  dependencies = { ...dependencies, ...overrides };
}

export function resetVoiceTranscriptionDependencies() {
  dependencies = { ...defaultDependencies };
}

export async function describeVoiceMedia(input: VoiceTranscriptionInput) {
  const text = await transcribeVoiceMedia(input);
  return text || null;
}

export async function transcribeVoiceMedia(input: VoiceTranscriptionInput) {
  try {
    const rawText = dependencies.transcribeAudio
      ? await withTimeout(dependencies.transcribeAudio(input), dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      : await transcribeWithOpenAI(input);
    const text = normalizeDescriptionText(String(rawText || ""));
    return text || null;
  } catch (error) {
    const logger = dependencies.logger === undefined ? console : dependencies.logger;
    logger?.warn("Voice transcription failed; using generic voice description.", error);
    return null;
  }
}

async function transcribeWithOpenAI(input: VoiceTranscriptionInput) {
  const asrClient = dependencies.asrClient === undefined ? defaultAsrClient : dependencies.asrClient;
  const transcriptions = asrClient?.audio?.transcriptions;
  if (!transcriptions?.create) {
    return null;
  }

  const file = await toFile(Buffer.from(input.bytes), input.fileName || "voice.silk", {
    type: input.mimeType || "application/octet-stream"
  });
  const response = await withTimeout(
    transcriptions.create({
      file,
      model: dependencies.asrModel || process.env.ASR_MODEL || DEFAULT_ASR_MODEL,
      response_format: "json"
    }),
    dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  return extractTranscriptionText(response);
}

function extractTranscriptionText(response: unknown) {
  if (typeof response === "string") {
    return response;
  }
  if (response && typeof response === "object" && "text" in response) {
    const text = (response as { text?: unknown }).text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Voice transcription timed out")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}
