/**
 * Resolves a user-selected model ID into a direct-provider model instance.
 *
 * Self-hosted on-prem: EVERY model routes directly to its provider using the
 * firm's own API keys. There is no Vercel AI Gateway in this deployment —
 * the gateway path was removed along with the Vercel hosting, because a
 * missing provider key would otherwise surface as a misleading "AI Gateway
 * authentication failed" error instead of "you haven't set OPENAI_API_KEY".
 *
 * Embeddings do NOT come through here — those are local and on-CPU. See
 * local-embed.ts.
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
 * Resolve a model ID to a direct provider model instance. Returns
 * `undefined` when the input is empty so the caller can fall back to its
 * module-level default.
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

  // Direct providers, in declaration order.
  if (opt.family === "anthropic" && hasEnv("ANTHROPIC_API_KEY")) {
    // Anthropic's direct API uses DASH-separated version IDs
    // (claude-opus-4-7) while the Vercel AI Gateway uses DOT-separated
    // (claude-opus-4.7). Our registry stores the gateway form; convert
    // dots to dashes here so direct calls reach the right model.
    return anthropic(modelName.replace(/\./g, "-"));
  }
  if (opt.family === "openai" && hasEnv("OPENAI_API_KEY")) {
    return openai(modelName);
  }
  if (opt.family === "google" && hasEnv("GOOGLE_GENERATIVE_AI_API_KEY")) {
    return google(modelName);
  }
  if (opt.family === "groq" && hasEnv("GROQ_API_KEY")) {
    // Groq IDs in our registry are prefixed with "groq/" — modelNameFromId
    // already strips that. For sub-namespaced models like
    // "groq/openai/gpt-oss-120b" → modelName == "openai/gpt-oss-120b"
    // which is exactly what Groq's API expects.
    return groq(modelName);
  }

  // No direct key set for this family. Self-hosted on-prem there is no
  // Vercel AI Gateway to fall back to, so returning the bare gateway-form
  // id would produce a confusing "AI Gateway authentication failed" error
  // for what is really a missing-key configuration problem. Fail with a
  // message that names the exact env var instead.
  throw new Error(
    `No API key configured for ${opt.family}. Set ${envVarForFamily(opt.family)} ` +
      `in your .env file to use ${opt.displayName}.`,
  );
}

/** Env var that enables a given model family. */
function envVarForFamily(family: ModelOption["family"]): string {
  switch (family) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
    case "groq":
      return "GROQ_API_KEY";
    case "manus":
      return "MANUS_API_KEY";
  }
}
