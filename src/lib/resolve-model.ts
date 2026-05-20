/**
 * Resolves a user-selected model ID into either:
 *   1. A direct-provider model instance (e.g. `anthropic("claude-opus-4-7")`)
 *      when the corresponding provider API key is set in the environment, OR
 *   2. The plain gateway-form string ("anthropic/claude-opus-4-7") that
 *      AI SDK v6 routes through Vercel AI Gateway when AI_GATEWAY_API_KEY
 *      is set.
 *
 * Direct providers are preferred when their keys are available because:
 *   - More predictable rate limits than the gateway pool
 *   - User-owned billing (some users prefer per-provider invoices)
 *   - Lower latency (one less hop)
 *
 * Gateway is the fallback so the agent keeps working even without direct keys.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { MODEL_OPTIONS, type ModelOption } from "./models";

const BY_ID = new Map<string, ModelOption>(MODEL_OPTIONS.map((m) => [m.id, m]));

/** Strip the "provider/" prefix from a gateway-style ID. */
function modelNameFromId(id: string): string {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function hasEnv(name: string): boolean {
  const v = process.env[name];
  return Boolean(v && v.trim().length > 0);
}

/**
 * Resolve a model ID to either a direct provider model instance or a
 * gateway-form string. Returns `undefined` when the input is empty so the
 * caller can fall back to its module-level default constant.
 */
export function resolveModelForUse(
  modelId: string | null | undefined,
): LanguageModel | undefined {
  if (!modelId) return undefined;
  const opt = BY_ID.get(modelId);
  if (!opt) {
    // Unknown ID — let the gateway figure it out (or fail loudly).
    return modelId;
  }
  const modelName = modelNameFromId(opt.id);

  // Prefer direct provider when its key is configured.
  if (opt.family === "anthropic" && hasEnv("ANTHROPIC_API_KEY")) {
    return anthropic(modelName);
  }
  if (opt.family === "openai" && hasEnv("OPENAI_API_KEY")) {
    return openai(modelName);
  }
  if (opt.family === "google" && hasEnv("GOOGLE_GENERATIVE_AI_API_KEY")) {
    return google(modelName);
  }

  // Fall back to gateway routing via AI_GATEWAY_API_KEY.
  return opt.id;
}
