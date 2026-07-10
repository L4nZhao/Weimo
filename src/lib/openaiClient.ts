import OpenAI from "openai";
import { config } from "./config.js";

let sharedOpenAI: OpenAI | null | undefined;
let sharedVisionOpenAI: OpenAI | null | undefined;

export function getSharedOpenAI(): OpenAI | null {
  sharedOpenAI ??= createOpenAIClient(config.openaiApiKey, config.openaiBaseUrl);
  return sharedOpenAI;
}

export function getSharedVisionOpenAI(): OpenAI | null {
  sharedVisionOpenAI ??= createOpenAIClient(config.visionApiKey, config.visionBaseUrl);
  return sharedVisionOpenAI;
}

function createOpenAIClient(apiKey?: string, baseURL?: string | null) {
  return apiKey
    ? new OpenAI({
        apiKey,
        baseURL: baseURL || undefined
      })
    : null;
}
