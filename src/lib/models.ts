/**
 * LLM model registry — the set of models the user can pick from in the
 * Model Selector dropdown. Every model is referenced as a Vercel AI Gateway
 * provider/model string so calls flow through the Pro AI Gateway credits.
 *
 * Each entry includes:
 *   - id          : gateway model ID (e.g. "anthropic/claude-opus-4-7")
 *   - displayName : short human label shown in the UI
 *   - family      : brand grouping (used to render section headers)
 *   - tier        : "premium" | "balanced" | "fast"  — speed/cost shorthand
 *   - description : one-line hint for the tooltip
 *   - korean      : informal note about Korean legal text quality (0-5)
 */

export type ModelFamily = "anthropic" | "openai" | "google";
export type ModelTier = "premium" | "balanced" | "fast";

export interface ModelOption {
  id: string;
  displayName: string;
  family: ModelFamily;
  tier: ModelTier;
  description: string;
  korean: 1 | 2 | 3 | 4 | 5;
}

/** Selectable models. Order matters — the UI renders them in this order. */
export const MODEL_OPTIONS: ModelOption[] = [
  // ─── Anthropic Claude ───────────────────────────────────────────────
  {
    id: "anthropic/claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    family: "anthropic",
    tier: "premium",
    description:
      "Anthropic's strongest reasoning model. Best for nuanced Korean legal analysis, complex citability judgments.",
    korean: 5,
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    family: "anthropic",
    tier: "balanced",
    description:
      "Balanced Anthropic model — excellent Korean legal handling at ~5× lower cost than Opus.",
    korean: 5,
  },
  // ─── OpenAI ChatGPT ────────────────────────────────────────────────
  {
    id: "openai/gpt-4o",
    displayName: "GPT-4o",
    family: "openai",
    tier: "premium",
    description:
      "OpenAI's flagship. Strong on Korean legal terminology; reliable structured outputs.",
    korean: 5,
  },
  {
    id: "openai/gpt-4o-mini",
    displayName: "GPT-4o mini",
    family: "openai",
    tier: "fast",
    description:
      "Cheap, fast OpenAI model. Lower legal nuance than full GPT-4o but ~15× cheaper.",
    korean: 4,
  },
  // ─── Google Gemini ─────────────────────────────────────────────────
  {
    id: "google/gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    family: "google",
    tier: "premium",
    description:
      "Google's flagship. Strong multilingual model; particularly good at long-context analysis.",
    korean: 4,
  },
  {
    id: "google/gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    family: "google",
    tier: "fast",
    description:
      "Fast Google model. Solid Korean handling at very low cost.",
    korean: 4,
  },
];

/** Default model — used when the user hasn't selected one yet. */
export const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4-6";

const MODEL_BY_ID = new Map(MODEL_OPTIONS.map((m) => [m.id, m]));

/** Resolve a model ID to its registry entry. Falls back to the default. */
export function resolveModel(id: string | null | undefined): ModelOption {
  if (id && MODEL_BY_ID.has(id)) return MODEL_BY_ID.get(id)!;
  return MODEL_BY_ID.get(DEFAULT_MODEL_ID)!;
}

/** Validate a model ID, returning a safe model ID for backend use. */
export function safeModelId(input: string | null | undefined): string {
  if (input && MODEL_BY_ID.has(input)) return input;
  return DEFAULT_MODEL_ID;
}

/** Family display order + labels for the selector UI. */
export const FAMILY_LABELS: Record<ModelFamily, { ko: string; en: string }> = {
  anthropic: { ko: "Anthropic Claude", en: "Anthropic Claude" },
  openai: { ko: "OpenAI ChatGPT", en: "OpenAI ChatGPT" },
  google: { ko: "Google Gemini", en: "Google Gemini" },
};

export const TIER_LABELS: Record<ModelTier, { ko: string; en: string }> = {
  premium: { ko: "최상급", en: "Premium" },
  balanced: { ko: "균형형", en: "Balanced" },
  fast: { ko: "고속형", en: "Fast" },
};
