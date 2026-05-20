/**
 * Resolves a user-selected model ID into either:
 *   1. A gateway-form string ("anthropic/claude-opus-4-7") routed via the
 *      Vercel AI Gateway when AI_GATEWAY_API_KEY is set (preferred), OR
 *   2. A direct-provider model instance (e.g. `anthropic("claude-opus-4-7")`)
 *      when the gateway key is absent but a direct provider key is set.
 *
 * Why gateway-first:
 *   - More forgiving structured-output normalization. Direct Anthropic with
 *     complex zod schemas sometimes returns valid JSON that fails zod
 *     validation; the gateway's compatibility layer smooths this over.
 *   - Single billing surface (Vercel Pro credits) instead of per-provider.
 *   - One code path to debug instead of N.
 *
 * Direct providers are kept as a fallback so the agent still works on
 * deployments without AI_GATEWAY_API_KEY (e.g. local development on a
 * laptop without Vercel credentials).
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
  // The Mixture-of-Agents pseudo-model is NOT a real upstream model — it's
  // a higher-level wrapper handled inside src/lib/moa.ts. Any direct AI SDK
  // caller (rerank, summarize, etc.) that received MoA should fall back to
  // its module default instead.
  if (opt.family === "auto") return undefined;

  const modelName = modelNameFromId(opt.id);

  // Prefer gateway routing — more reliable JSON-schema normalization.
  if (hasEnv("AI_GATEWAY_API_KEY")) {
    return opt.id;
  }

  // No gateway → fall back to direct provider when its key is configured.
  if (opt.family === "anthropic" && hasEnv("ANTHROPIC_API_KEY")) {
    return anthropic(modelName);
  }
  if (opt.family === "openai" && hasEnv("OPENAI_API_KEY")) {
    return openai(modelName);
  }
  if (opt.family === "google" && hasEnv("GOOGLE_GENERATIVE_AI_API_KEY")) {
    return google(modelName);
  }
  // xAI / DeepSeek / Meta / Moonshot / Mistral / auto are only reachable
  // via the Vercel AI Gateway — we don't ship direct providers for them
  // because that would require shipping their SDKs + per-provider keys.
  // If the user picks one without AI_GATEWAY_API_KEY set, returning the
  // gateway-form id below produces a clean "no API key" error downstream.

  // No keys configured at all — return the gateway string as a last resort
  // (will fail with a clear "no API key" error downstream).
  return opt.id;
}
