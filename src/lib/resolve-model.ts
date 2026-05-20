/**
 * Resolves a user-selected model ID into either:
 *   1. A direct-provider model instance (e.g. `groq("llama-3.3-70b-...")`)
 *      when the matching direct-provider key is set — PREFERRED.
 *   2. A gateway-form string ("anthropic/claude-opus-4.7") routed via the
 *      Vercel AI Gateway when no direct key is available.
 *
 * Why direct-first (changed Nov 2026):
 *   - The Vercel AI Gateway requires prepaid credits in a separate balance
 *     from the Pro plan's $20 included credit. When that balance hits $0,
 *     the gateway returns 402 "insufficient funds" and every call fails.
 *   - Going direct (Anthropic / OpenAI / Google / Groq) uses each provider's
 *     own billing — including FREE tiers (Groq 1000+ rpd, Gemini 1500 rpd)
 *     which keep the app working at $0 even when the gateway is empty.
 *   - The previous "gateway first for JSON-schema normalization" rationale
 *     is mooted by our retry-on-parse-fail logic in moa.ts and extractor.ts.
 *
 * The gateway is still used for families without a direct provider in the
 * project (xAI, DeepSeek, Meta, Mistral) — they'll fail with a clear
 * "insufficient funds" message if the gateway is empty, telling the user
 * to top up or pick a different model.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
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

  // ── PREFER DIRECT PROVIDERS ───────────────────────────────────────
  // Each provider has its own billing surface. Going direct uses the
  // user's separate Anthropic/OpenAI/Google/Groq accounts — including
  // their free tiers when available. The gateway is the LAST resort.
  if (opt.family === "groq" && hasEnv("GROQ_API_KEY")) {
    return groq(modelName);
  }
  if (opt.family === "anthropic" && hasEnv("ANTHROPIC_API_KEY")) {
    return anthropic(modelName);
  }
  if (opt.family === "openai" && hasEnv("OPENAI_API_KEY")) {
    return openai(modelName);
  }
  if (opt.family === "google" && hasEnv("GOOGLE_GENERATIVE_AI_API_KEY")) {
    return google(modelName);
  }

  // ── GATEWAY FALLBACK ──────────────────────────────────────────────
  // xAI / DeepSeek / Meta / Mistral only reach via the gateway (we don't
  // ship those SDKs in the project). When the gateway is out of funds,
  // these will fail with a clear 402 error and the user will see the
  // "insufficient funds" message in their turn.
  if (hasEnv("AI_GATEWAY_API_KEY")) {
    return opt.id;
  }

  // No keys configured at all — return the gateway string as a last resort.
  return opt.id;
}
