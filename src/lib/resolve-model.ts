/**
 * Resolves a user-selected model ID into a direct-provider model instance.
 *
 * The 7-model registry only contains Anthropic, OpenAI, and Google entries
 * (the providers the user has direct billing credit on). We always route
 * direct — the Vercel AI Gateway is intentionally NOT used as a fallback,
 * because its prepaid balance is currently empty and would just produce
 * "insufficient funds" errors that look like product bugs.
 *
 * If a future model is added in a family we don't have a direct SDK for,
 * this function will return the gateway-form id as a last resort. The
 * caller will then see a clear API error if the gateway is unfunded.
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
    return anthropic(modelName);
  }
  if (opt.family === "openai" && hasEnv("OPENAI_API_KEY")) {
    return openai(modelName);
  }
  if (opt.family === "google" && hasEnv("GOOGLE_GENERATIVE_AI_API_KEY")) {
    return google(modelName);
  }

  // No direct key set — last resort is the gateway. Will fail with a
  // clear 402 if the gateway is unfunded; the user sees that in the
  // turn's error message.
  return opt.id;
}
