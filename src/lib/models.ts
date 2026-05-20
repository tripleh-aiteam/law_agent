/**
 * LLM model registry — the set of models the user can pick from in the
 * Model Selector dropdown. Every model is referenced as a Vercel AI Gateway
 * provider/model string so calls flow through the Pro AI Gateway credits.
 *
 * IDs MUST match the canonical form returned by
 *   GET https://ai-gateway.vercel.sh/v1/models
 *
 * Anthropic / Google / xAI / DeepSeek / OpenAI all use DOT-separated
 * versions (e.g. `claude-opus-4.7`, NOT `claude-opus-4-7`). The gateway
 * silently aliases the dash form for the most common Anthropic IDs but
 * NOT for xAI — that's why our previous `xai/grok-4` failed with
 * "Model 'xai/grok-4' not found". The flagship is `xai/grok-4.3`.
 *
 * Each entry includes:
 *   - id          : gateway model ID (verified against the live catalog)
 *   - displayName : short human label shown in the UI
 *   - family      : brand grouping (used to render section headers)
 *   - tier        : "premium" | "balanced" | "fast"  — speed/cost shorthand
 *   - description : one-line hint for the tooltip
 *   - korean      : informal note about Korean legal text quality (0–5)
 *   - experimental: optional flag for models known to occasionally return
 *                   malformed JSON on our complex structured-output schema
 */

export type ModelFamily =
  | "auto"
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "meta"
  | "mistral"
  | "groq";

export type ModelTier = "premium" | "balanced" | "fast";

export interface ModelOption {
  id: string;
  displayName: string;
  family: ModelFamily;
  tier: ModelTier;
  description: string;
  korean: 1 | 2 | 3 | 4 | 5;
  /** True when the model is known to occasionally fail strict JSON-schema mode. */
  experimental?: boolean;
}

/**
 * The special Mixture-of-Agents model. Selecting this fans the same prompt
 * out to several strong models in parallel and uses Claude Opus 4.7 as an
 * aggregator to synthesize the final answer. See `src/lib/moa.ts`.
 */
export const MOA_MODEL_ID = "auto/mixture-of-agents";

/**
 * The candidate roster for Mixture-of-Agents. Currently configured for
 * FREE MODE — every entry runs on a free-tier provider so MoA queries
 * cost $0 until the user tops up their Vercel AI Gateway credit.
 *
 *   1. Groq Llama 3.3 70B   — Meta Llama, Groq's free tier. Very fast.
 *   2. Groq Llama 4 Scout   — Newer Meta variant, multimodal. Free.
 *   3. Google Gemini 2.5 Flash — Direct Google AI Studio (1,500 RPD free).
 *   4. Groq Qwen 3 32B      — Alibaba Qwen, different family. Free.
 *
 * All run via DIRECT provider keys, NOT the Vercel AI Gateway, so they
 * don't draw from the (currently empty) gateway credit balance.
 */
export const MOA_ROSTER: readonly string[] = [
  "groq/llama-3.3-70b-versatile",
  "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "google/gemini-2.5-flash",
  "groq/qwen/qwen3-32b",
];

/**
 * The aggregator model that synthesizes the candidate outputs.
 * FREE MODE: Groq's openai/gpt-oss-120b — a large open-weight OpenAI-style
 * model running on Groq's free tier. Strong meta-reasoning at $0.
 * Different family from every candidate, so no self-bias.
 */
export const MOA_AGGREGATOR_MODEL_ID = "groq/openai/gpt-oss-120b";

/** Selectable models. Order matters — the UI renders them in this order. */
export const MODEL_OPTIONS: ModelOption[] = [
  // ─── Mixture-of-Agents (pinned to the top of the selector) ─────────
  {
    id: MOA_MODEL_ID,
    displayName: "Mixture-of-Agents (FREE)",
    family: "auto",
    tier: "premium",
    description:
      "FREE MODE: 4 free-tier candidates (Llama 3.3 70B + Llama 4 Scout + Gemini 2.5 Flash + Qwen 3) run in parallel, then GPT-OSS 120B synthesizes. Routes via direct Groq + Google free APIs, NOT the paid gateway. $0/query.",
    korean: 4,
  },
  // ─── Groq (FREE TIER — direct API, bypasses paid gateway) ──────────
  // Groq's free tier serves these open-weight models at very high speed
  // (~500 tok/s). Rate limits are generous enough for normal use.
  {
    id: "groq/llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B",
    family: "groq",
    tier: "balanced",
    description:
      "FREE via Groq direct API. Meta's strong general model — ~500 tok/s. Decent Korean, no gateway cost.",
    korean: 3,
  },
  {
    id: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
    displayName: "Llama 4 Scout",
    family: "groq",
    tier: "fast",
    description:
      "FREE via Groq. Newer Meta Llama 4 Scout, multimodal-capable. Fast.",
    korean: 3,
  },
  {
    id: "groq/llama-3.1-8b-instant",
    displayName: "Llama 3.1 8B Instant",
    family: "groq",
    tier: "fast",
    description:
      "FREE via Groq. Tiny + extremely fast (~800 tok/s). Good for short queries.",
    korean: 3,
  },
  {
    id: "groq/qwen/qwen3-32b",
    displayName: "Qwen 3 32B",
    family: "groq",
    tier: "balanced",
    description:
      "FREE via Groq. Alibaba Qwen — strong CJK (Korean / Chinese / Japanese) for an open model.",
    korean: 4,
  },
  {
    id: "groq/openai/gpt-oss-120b",
    displayName: "GPT-OSS 120B",
    family: "groq",
    tier: "balanced",
    description:
      "FREE via Groq. OpenAI's open-weight 120B model. Strong reasoning, useful as a free aggregator.",
    korean: 3,
  },
  {
    id: "groq/openai/gpt-oss-20b",
    displayName: "GPT-OSS 20B",
    family: "groq",
    tier: "fast",
    description: "FREE via Groq. Smaller open-weight OpenAI model.",
    korean: 3,
  },

  // ─── Anthropic Claude ───────────────────────────────────────────────
  {
    id: "anthropic/claude-opus-4.7",
    displayName: "Claude Opus 4.7",
    family: "anthropic",
    tier: "premium",
    description:
      "Anthropic's strongest reasoning model. Best for nuanced Korean legal analysis, complex citability judgments.",
    korean: 5,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    displayName: "Claude Sonnet 4.6",
    family: "anthropic",
    tier: "balanced",
    description:
      "Balanced Anthropic model — excellent Korean legal handling at ~5× lower cost than Opus.",
    korean: 5,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    displayName: "Claude Haiku 4.5",
    family: "anthropic",
    tier: "fast",
    description:
      "Fast, cheap Anthropic model. Strong for quick element extraction; legal nuance is shallower than Sonnet.",
    korean: 4,
  },
  {
    id: "anthropic/claude-opus-4.6",
    displayName: "Claude Opus 4.6",
    family: "anthropic",
    tier: "premium",
    description: "Prior-generation Opus. Useful for A/B against 4.7.",
    korean: 5,
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    displayName: "Claude Sonnet 4.5",
    family: "anthropic",
    tier: "balanced",
    description: "Prior-generation Sonnet. Useful for A/B against 4.6.",
    korean: 5,
  },

  // ─── OpenAI ─────────────────────────────────────────────────────────
  {
    id: "openai/gpt-5.5",
    displayName: "GPT-5.5",
    family: "openai",
    tier: "premium",
    description:
      "OpenAI's flagship. Best overall reasoning + structured output reliability.",
    korean: 5,
  },
  {
    id: "openai/gpt-5.5-pro",
    displayName: "GPT-5.5 Pro",
    family: "openai",
    tier: "premium",
    description: "Higher-compute GPT-5.5 variant for hardest tasks.",
    korean: 5,
  },
  {
    id: "openai/gpt-5.4",
    displayName: "GPT-5.4",
    family: "openai",
    tier: "premium",
    description: "Prior flagship — still extremely capable, slightly cheaper than 5.5.",
    korean: 5,
  },
  {
    id: "openai/gpt-5.4-mini",
    displayName: "GPT-5.4 mini",
    family: "openai",
    tier: "balanced",
    description: "Mid-tier GPT-5.4. Solid Korean, much cheaper than full 5.4.",
    korean: 4,
  },
  {
    id: "openai/gpt-5.4-nano",
    displayName: "GPT-5.4 nano",
    family: "openai",
    tier: "fast",
    description: "Cheapest GPT-5.4 variant. Fast, good for short queries.",
    korean: 4,
  },
  {
    id: "openai/gpt-4o",
    displayName: "GPT-4o",
    family: "openai",
    tier: "premium",
    description:
      "Reliable older flagship. Excellent structured output, strong Korean.",
    korean: 5,
  },
  {
    id: "openai/gpt-4o-mini",
    displayName: "GPT-4o mini",
    family: "openai",
    tier: "fast",
    description: "Cheap, fast OpenAI. Best price/quality for high-volume use.",
    korean: 4,
  },
  {
    id: "openai/o3",
    displayName: "o3",
    family: "openai",
    tier: "premium",
    description:
      "OpenAI's reasoning model. Best for multi-step legal analysis; higher latency.",
    korean: 4,
  },
  {
    id: "openai/o3-mini",
    displayName: "o3-mini",
    family: "openai",
    tier: "balanced",
    description: "Cheaper reasoning model. Good balance of cost and depth.",
    korean: 4,
  },
  {
    id: "openai/o3-pro",
    displayName: "o3-pro",
    family: "openai",
    tier: "premium",
    description: "Heavyweight reasoning. Slow but very thorough on complex cases.",
    korean: 4,
  },
  {
    id: "openai/o4-mini",
    displayName: "o4-mini",
    family: "openai",
    tier: "balanced",
    description: "Next-gen reasoning, cheaper variant.",
    korean: 4,
  },

  // ─── xAI Grok ───────────────────────────────────────────────────────
  {
    id: "xai/grok-4.3",
    displayName: "Grok 4.3",
    family: "xai",
    tier: "premium",
    description:
      "xAI's current flagship. Strong tool-use and structured output; weaker Korean nuance than Claude/GPT but useful for diverse-viewpoint ensembles.",
    korean: 3,
  },
  {
    id: "xai/grok-4.20-reasoning",
    displayName: "Grok 4.20 (reasoning)",
    family: "xai",
    tier: "premium",
    description: "Reasoning variant of Grok 4.20 — deeper analysis, slower.",
    korean: 3,
  },
  {
    id: "xai/grok-4.20-non-reasoning",
    displayName: "Grok 4.20",
    family: "xai",
    tier: "balanced",
    description: "Non-reasoning Grok 4.20 — faster, lower cost.",
    korean: 3,
  },
  {
    id: "xai/grok-4.1-fast-reasoning",
    displayName: "Grok 4.1 Fast (reasoning)",
    family: "xai",
    tier: "fast",
    description: "Cheaper xAI option with reasoning enabled.",
    korean: 3,
  },

  // ─── DeepSeek ───────────────────────────────────────────────────────
  {
    id: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    family: "deepseek",
    tier: "premium",
    description:
      "DeepSeek's flagship. Strong Korean handling at very low cost.",
    korean: 4,
  },
  {
    id: "deepseek/deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    family: "deepseek",
    tier: "balanced",
    description: "Newer mid-tier DeepSeek. Solid balance of cost and quality.",
    korean: 4,
  },
  {
    id: "deepseek/deepseek-v3",
    displayName: "DeepSeek V3",
    family: "deepseek",
    tier: "balanced",
    description: "Open-weight V3. Very cost-efficient.",
    korean: 4,
  },
  {
    id: "deepseek/deepseek-r1",
    displayName: "DeepSeek R1",
    family: "deepseek",
    tier: "premium",
    description: "DeepSeek's reasoning model. Strong analytical depth.",
    korean: 4,
  },

  // ─── Google Gemini (experimental on JSON-schema mode) ───────────────
  {
    id: "google/gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    family: "google",
    tier: "premium",
    description:
      "Google's newest flagship preview. Excellent long-context. JSON-schema mode is sometimes flaky — we'll retry on failure.",
    korean: 4,
    experimental: true,
  },
  {
    id: "google/gemini-3-pro-preview",
    displayName: "Gemini 3 Pro Preview",
    family: "google",
    tier: "premium",
    description: "Gemini 3 flagship preview. Strong on Korean long-context.",
    korean: 4,
    experimental: true,
  },
  {
    id: "google/gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    family: "google",
    tier: "premium",
    description: "Stable Gemini flagship. Long-context Korean documents.",
    korean: 4,
    experimental: true,
  },
  {
    id: "google/gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    family: "google",
    tier: "fast",
    description:
      "Newest fast Gemini — 1M context, vision, tool-use, reasoning. Fast and cheap; JSON-schema mode much improved over 2.5.",
    korean: 4,
    experimental: true,
  },
  {
    id: "google/gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    family: "google",
    tier: "fast",
    description:
      "Fast Gemini. Good for quick summaries; structured output ~70% reliable.",
    korean: 4,
    experimental: true,
  },
  {
    id: "google/gemini-3.1-flash-lite",
    displayName: "Gemini 3.1 Flash Lite",
    family: "google",
    tier: "fast",
    description: "Cheapest current Gemini. Useful for high-volume light tasks.",
    korean: 4,
    experimental: true,
  },

  // ─── Meta Llama ─────────────────────────────────────────────────────
  {
    id: "meta/llama-4-maverick",
    displayName: "Llama 4 Maverick",
    family: "meta",
    tier: "balanced",
    description: "Larger Llama 4 variant. Better reasoning at modest cost.",
    korean: 3,
  },
  {
    id: "meta/llama-4-scout",
    displayName: "Llama 4 Scout",
    family: "meta",
    tier: "fast",
    description: "Meta's small Llama 4. Multilingual; fast and inexpensive.",
    korean: 3,
  },
  {
    id: "meta/llama-3.3-70b",
    displayName: "Llama 3.3 70B",
    family: "meta",
    tier: "balanced",
    description: "Stable previous-gen Meta. Reliable, well-tested.",
    korean: 3,
  },

  // ─── Mistral ────────────────────────────────────────────────────────
  {
    id: "mistral/mistral-large-3",
    displayName: "Mistral Large 3",
    family: "mistral",
    tier: "balanced",
    description:
      "Mistral's flagship. Decent multilingual reasoning; weaker Korean than Claude/GPT.",
    korean: 3,
  },
  {
    id: "mistral/mistral-medium-3.5",
    displayName: "Mistral Medium 3.5",
    family: "mistral",
    tier: "balanced",
    description: "Mid-size Mistral. Good cost balance.",
    korean: 3,
  },
];

/**
 * Default model — used when the user hasn't selected one yet.
 *
 * FREE MODE: Gemini 2.5 Flash via direct Google AI Studio API. The user's
 * Vercel AI Gateway credit is empty; this default avoids the gateway
 * entirely while still giving solid Korean legal handling at $0.
 *
 * When the user tops up gateway credit, switch this back to
 * "anthropic/claude-sonnet-4.6" for the previous default.
 */
export const DEFAULT_MODEL_ID = "google/gemini-2.5-flash";

const MODEL_BY_ID = new Map(MODEL_OPTIONS.map((m) => [m.id, m]));

/**
 * Back-compat: older localStorage payloads may carry dash-style IDs
 * (`anthropic/claude-sonnet-4-6`) from before we switched to the canonical
 * dot form. Map them onto the current canonical IDs so users don't lose
 * their model selection across deploys.
 */
const LEGACY_ID_ALIASES: Record<string, string> = {
  "anthropic/claude-opus-4-7": "anthropic/claude-opus-4.7",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "xai/grok-4": "xai/grok-4.3",
  "xai/grok-4-heavy": "xai/grok-4.20-reasoning",
  "deepseek/deepseek-v3": "deepseek/deepseek-v3",
  "deepseek/deepseek-r1": "deepseek/deepseek-r1",
  "mistral/mistral-large": "mistral/mistral-large-3",
  "moonshot/kimi-k2": "anthropic/claude-sonnet-4.6", // dropped from registry
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

/**
 * Validate a model ID, returning a safe model ID for backend use.
 *
 * MoA is NOT a real upstream model — it's a wrapper. Any caller that asks
 * `safeModelId` to validate "auto/mixture-of-agents" wants a real model to
 * send to the AI SDK, so we substitute the default here.
 */
export function safeModelId(input: string | null | undefined): string {
  if (input === MOA_MODEL_ID) return DEFAULT_MODEL_ID;
  const canonical = canonicalizeId(input);
  if (canonical && MODEL_BY_ID.has(canonical)) return canonical;
  return DEFAULT_MODEL_ID;
}

/** True iff the given id is the Mixture-of-Agents pseudo-model. */
export function isMoaModelId(id: string | null | undefined): boolean {
  return id === MOA_MODEL_ID;
}

/** Family display order + labels for the selector UI. */
export const FAMILY_LABELS: Record<ModelFamily, { ko: string; en: string }> = {
  auto: { ko: "자동 (앙상블)", en: "Auto (Ensemble)" },
  groq: { ko: "Groq (무료)", en: "Groq (Free)" },
  anthropic: { ko: "Anthropic Claude", en: "Anthropic Claude" },
  openai: { ko: "OpenAI", en: "OpenAI" },
  xai: { ko: "xAI Grok", en: "xAI Grok" },
  google: { ko: "Google Gemini", en: "Google Gemini" },
  deepseek: { ko: "DeepSeek", en: "DeepSeek" },
  meta: { ko: "Meta Llama", en: "Meta Llama" },
  mistral: { ko: "Mistral", en: "Mistral" },
};

export const TIER_LABELS: Record<ModelTier, { ko: string; en: string }> = {
  premium: { ko: "최상급", en: "Premium" },
  balanced: { ko: "균형형", en: "Balanced" },
  fast: { ko: "고속형", en: "Fast" },
};
