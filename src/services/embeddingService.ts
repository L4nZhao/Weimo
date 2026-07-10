import { config } from "../lib/config.js";
import type { ExtractedReportFields } from "./aiExtractor.js";

type EmbeddingResult = {
  embedding: number[];
  model: string;
};

type EmbeddingResponse = {
  data?: Array<{ embedding?: number[] }>;
  model?: string;
  error?: { message?: string };
};

export function hasEmbeddingProvider() {
  return Boolean(config.dashscopeApiKey);
}

export async function embedText(text: string): Promise<EmbeddingResult | null> {
  const input = text.trim();
  if (!config.dashscopeApiKey || !input) {
    return null;
  }

  try {
    const response = await fetch(`${config.dashscopeBaseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.dashscopeApiKey}`
      },
      body: JSON.stringify({
        model: config.dashscopeEmbeddingModel,
        input
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = (await response.json()) as EmbeddingResponse;
    const embedding = data.data?.[0]?.embedding;
    if (!response.ok || !Array.isArray(embedding)) {
      throw new Error(data.error?.message || `DashScope embedding failed: ${response.status}`);
    }
    return {
      embedding,
      model: data.model || config.dashscopeEmbeddingModel
    };
  } catch (error) {
    console.error("DashScope embedding failed", error);
    return null;
  }
}

export function buildReportEmbeddingText(input: {
  title: string;
  rawText: string;
  fields: ExtractedReportFields;
  memberName: string;
  projectName?: string | null;
}) {
  return [
    input.title,
    input.projectName,
    input.memberName,
    input.rawText,
    input.fields.project_name,
    input.fields.task_name,
    input.fields.completed_work,
    input.fields.issues,
    input.fields.next_plan,
    input.fields.summary
  ]
    .filter(Boolean)
    .join("\n");
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (!normA || !normB) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function parseEmbedding(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : null;
  } catch {
    return null;
  }
}
