/**
 * LLM model registry — exactly 7 strongest models for Korean legal work.
 *
 * Design decisions (pinned by user):
 *   - ONLY models from providers where the user has direct billing credit
 *     (Anthropic, OpenAI, Google). No xAI/DeepSeek/Meta/Mistral here —
 *     those need the Vercel AI Gateway which is currently empty.
 *   - No Mixture-of-Agents — user picks 1+ models themselves and compares
 *     the parallel results to choose the best. Machine doesn't aggregate.
 *   - Money is not the constraint; accuracy is. Even the "cheap" entries
 *     are premium-tier within their family.
 *
 * IDs match the canonical Vercel AI Gateway form so the same registry
 * works for direct AND gateway paths (resolve-model.ts handles routing).
 */

export type ModelFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "groq"
  | "manus";

export type ModelTier = "premium" | "balanced" | "fast";

export interface ModelOption {
  id: string;
  displayName: string;
  family: ModelFamily;
  tier: ModelTier;
  description: string;
  korean: 1 | 2 | 3 | 4 | 5;
  /** True when the model occasionally returns malformed JSON on our schema. */
  experimental?: boolean;
}

/** The 8 strongest models. Order = display order in the selector.
 *  Manus first (premium autonomous agent), then Claude, ChatGPT, Gemini. */
export const MODEL_OPTIONS: ModelOption[] = [
  // ─── Manus (autonomous agent — pinned to top per user preference) ────
  // Not just an LLM: Manus is a full autonomous agent that browses the web,
  // executes code, and produces multi-step research reports. It runs ASYNC
  // (5–30 min per task) and costs much more than a plain LLM call
  // (~$0.50–$5 per task vs. ~$0.05 for Claude). Use it when you want
  // research that goes beyond what's in our local 판례 corpus.
  {
    id: "manus/agent",
    displayName: "Manus (autonomous agent)",
    family: "manus",
    tier: "premium",
    description:
      "Full autonomous agent — browses the web, drafts reports, runs multi-step research. SLOW (5–30 min per task) and EXPENSIVE (~$0.50–$5/query). Use for hard cases that need live court-case research, not for routine queries. Needs MANUS_API_KEY on Vercel.",
    korean: 4,
    experimental: true,
  },

  // ─── Claude (best Korean legal nuance) ──────────────────────────────
  // Opus 4.7 removed per user request — it was strict about non-case
  // input documents and burned credit on long contexts. Sonnet 4.6 is
  // the daily driver: nearly Opus-quality at 1/5 cost, and it's the
  // same model Manus uses under the hood. Re-add Opus later if needed.
  {
    id: "anthropic/claude-sonnet-4.6",
    displayName: "Claude Sonnet 4.6",
    family: "anthropic",
    tier: "premium",
    description:
      "Excellent Korean legal handling. The same model Manus AI uses under the hood. Default Claude model. ~$0.05/query.",
    korean: 5,
  },

  // ─── ChatGPT (strongest reasoning + most reliable structured output) ──
  {
    id: "openai/gpt-5.5",
    displayName: "ChatGPT 5.5",
    family: "openai",
    tier: "premium",
    description:
      "OpenAI flagship. Strongest reasoning + most reliable structured output across providers. Strong Korean. ~$0.07/query.",
    korean: 5,
  },
  {
    id: "openai/gpt-5.5-pro",
    displayName: "ChatGPT 5.5 Pro",
    family: "openai",
    tier: "premium",
    description:
      "Higher-compute GPT-5.5 variant. Use for the hardest cases where you want maximum deliberation. ~$0.15/query.",
    korean: 5,
  },

  // ─── Gemini (cross-vendor viewpoint) ────────────────────────────────
  {
    id: "google/gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    family: "google",
    tier: "premium",
    description:
      "Google's flagship preview. Different vendor than Anthropic/OpenAI — cross-checks the dominant axis. Needs GOOGLE_GENERATIVE_AI_API_KEY on Vercel. ~$0.04/query.",
    korean: 4,
    experimental: true,
  },

  // ─── Free LLMs (via Groq — open-weight flagships, no per-query cost) ─
  // Groq's free tier hosts powerful open-weight models at ~500 tok/s. All
  // three picks below support strict json_schema (verified in production).
  // Routed via direct GROQ_API_KEY, NOT the Vercel AI Gateway, so they
  // don't draw from any paid credit pool.
  {
    id: "groq/openai/gpt-oss-120b",
    displayName: "Open GPT 120B",
    family: "groq",
    tier: "premium",
    description:
      "FREE — OpenAI's open-weight 120B model (released under an open license — distinct from the paid ChatGPT models above). Strong reasoning + reliable JSON. The most powerful free model. No per-query cost.",
    korean: 3,
  },
  {
    id: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
    displayName: "Llama 4 Scout",
    family: "groq",
    tier: "premium",
    description:
      "FREE — Meta's Llama 4 Scout (17B-active, 16-expert MoE) via Groq. Strong general reasoning, supports strict json_schema. No per-query cost.",
    korean: 3,
  },
];

/** Default model when none selected — best price/quality. */
export const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.6";

/** Default multi-selection — Sonnet only on first load. */
export const DEFAULT_SELECTED_MODEL_IDS: readonly string[] = [DEFAULT_MODEL_ID];

const MODEL_BY_ID = new Map(MODEL_OPTIONS.map((m) => [m.id, m]));

/**
 * Back-compat: map old model IDs (from prior deploys' localStorage) onto
 * the 7-model roster so the user's saved selection doesn't break across
 * the migration.
 */
const LEGACY_ID_ALIASES: Record<string, string> = {
  // Anthropic — only Sonnet 4.6 remains in the registry. Every other
  // Claude id (dashed, dotted, older gens, Opus, Haiku) migrates to it.
  "anthropic/claude-opus-4.7": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4-7": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4-5": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4-5": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5": "anthropic/claude-sonnet-4.6",
  "openai/gpt-4o-mini": "openai/gpt-5.5",
  "openai/gpt-4o": "openai/gpt-5.5",
  "openai/o3-pro": "openai/gpt-5.5",
  "openai/o3": "openai/gpt-5.5",
  "openai/o3-mini": "openai/gpt-5.5",
  "openai/o1": "openai/gpt-5.5",
  "openai/o4-mini": "openai/gpt-5.5",
  "openai/gpt-5.4": "openai/gpt-5.5",
  "openai/gpt-5.4-mini": "openai/gpt-5.5",
  "openai/gpt-5.4-nano": "openai/gpt-5.5",
  "google/gemini-2.5-pro": "google/gemini-3.1-pro-preview",
  "google/gemini-2.5-flash": "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash": "google/gemini-3.1-pro-preview",
  "google/gemini-3-pro-preview": "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite": "google/gemini-3.1-pro-preview",
  // Mixture-of-Agents was removed entirely — fall back to Claude Sonnet
  "auto/mixture-of-agents": "anthropic/claude-sonnet-4.6",
  // Groq legacy aliases — current free roster is gpt-oss-120b + llama-4-scout.
  // Anything older or not in the user's account migrates to gpt-oss-120b
  // (the most powerful free option).
  "groq/openai/gpt-oss-20b": "groq/openai/gpt-oss-120b",
  "groq/meta-llama/llama-4-maverick-17b-128e-instruct": "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/moonshotai/kimi-k2-instruct": "groq/openai/gpt-oss-120b",
  "groq/llama-3.3-70b-versatile": "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/llama-3.1-8b-instant": "groq/openai/gpt-oss-120b",
  "groq/qwen/qwen3-32b": "groq/openai/gpt-oss-120b",
  "xai/grok-4": "anthropic/claude-sonnet-4.6",
  "xai/grok-4-heavy": "anthropic/claude-sonnet-4.6",
  "xai/grok-4.3": "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-v3": "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-r1": "openai/o3-pro",
  "deepseek/deepseek-v4-pro": "anthropic/claude-sonnet-4.6",
  "mistral/mistral-large": "openai/gpt-4o",
  "mistral/mistral-large-3": "openai/gpt-4o",
  "moonshot/kimi-k2": "anthropic/claude-sonnet-4.6",
};

function canonicalizeId(id: string | null | undefined): string | null {
  if (!id) return null;
  return LEGACY_ID_ALIASES[id] ?? id;
}

/** Resolve a model ID to its registry entry. Falls back to the default. */
export function resolveModel(id: string | null | undefined): ModelOption {
  const canonical = canonicalizeId(id);
  if (canonical && MODEL_BY_ID.has(canonical))
    return MODEL_BY_ID.get(canonical)!;
  return MODEL_BY_ID.get(DEFAULT_MODEL_ID)!;
}

/** Validate a model ID, returning a safe model ID for backend use. */
export function safeModelId(input: string | null | undefined): string {
  const canonical = canonicalizeId(input);
  if (canonical && MODEL_BY_ID.has(canonical)) return canonical;
  return DEFAULT_MODEL_ID;
}

/** Canonicalize + dedupe an array of model IDs against the registry. */
export function safeModelIds(input: readonly string[] | null | undefined): string[] {
  if (!input || input.length === 0) return [...DEFAULT_SELECTED_MODEL_IDS];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    const c = canonicalizeId(raw);
    if (c && MODEL_BY_ID.has(c) && !seen.has(c)) {
      seen.add(c);
      result.push(c);
    }
  }
  // If migration cleared everything, fall back to default rather than empty.
  return result.length > 0 ? result : [...DEFAULT_SELECTED_MODEL_IDS];
}

/**
 * Family display order + labels for the selector UI.
 * Labels are intentionally consumer-friendly: drop the parent-company
 * prefix ("Anthropic", "Google") and use the user-recognizable brand
 * name only ("Claude", "ChatGPT", "Gemini").
 */
export const FAMILY_LABELS: Record<ModelFamily, { ko: string; en: string }> = {
  anthropic: { ko: "Claude", en: "Claude" },
  openai: { ko: "ChatGPT", en: "ChatGPT" },
  google: { ko: "Gemini", en: "Gemini" },
  groq: { ko: "무료 LLM", en: "Free LLMs" },
  manus: { ko: "Manus", en: "Manus" },
};

export const TIER_LABELS: Record<ModelTier, { ko: string; en: string }> = {
  premium: { ko: "최상급", en: "Premium" },
  balanced: { ko: "균형형", en: "Balanced" },
  fast: { ko: "고속형", en: "Fast" },
};
