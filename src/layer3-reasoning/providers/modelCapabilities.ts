/**
 * Per-model request-shape rules for the Anthropic API.
 *
 * These models do not share a request surface, and the differences are 400 errors rather
 * than warnings — a single shared request builder breaks the moment the user switches
 * models in settings. Everything that varies lives here.
 */

export const ANTHROPIC_MODELS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const;

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelCapabilities {
  /** `thinking: {type:'adaptive'}`. When false, the model uses `budget_tokens` instead. */
  adaptiveThinking: boolean;
  /**
   * True when thinking runs even if the `thinking` field is omitted. Opus 4.8 does NOT —
   * omitting the field means no thinking at all, so it must always be set explicitly.
   */
  thinkingOnByDefault: boolean;
  /** `output_config.effort`. Rejected outright by Haiku 4.5. */
  effort: boolean;
  /** `temperature` / `top_p` / `top_k`. Removed on the Opus 4.8 and Sonnet 5 tiers. */
  samplingParams: boolean;
  /** Minimum prefix length before `cache_control` does anything. Shorter prefixes silently do not cache. */
  cacheMinTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  /** Server-side compaction via the `compact-2026-01-12` beta. */
  compaction: boolean;
}

const CAPABILITIES: Record<string, ModelCapabilities> = {
  'claude-opus-4-8': {
    adaptiveThinking: true,
    // Opus 4.8 runs *without* thinking when the field is omitted.
    thinkingOnByDefault: false,
    effort: true,
    samplingParams: false,
    cacheMinTokens: 4096,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    compaction: true,
  },
  'claude-sonnet-5': {
    adaptiveThinking: true,
    // Sonnet 5 is the inverse of Opus 4.8 here: omitting `thinking` runs adaptive.
    thinkingOnByDefault: true,
    effort: true,
    samplingParams: false,
    cacheMinTokens: 2048,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    compaction: true,
  },
  'claude-haiku-4-5': {
    // The outlier: no adaptive thinking, no effort, and `budget_tokens` is required
    // for thinking rather than rejected.
    adaptiveThinking: false,
    thinkingOnByDefault: false,
    effort: false,
    samplingParams: true,
    cacheMinTokens: 4096,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    compaction: false,
  },
};

/** Conservative defaults for a model ID we do not recognise, e.g. one set by hand in settings. */
const UNKNOWN_MODEL: ModelCapabilities = {
  adaptiveThinking: false,
  thinkingOnByDefault: false,
  effort: false,
  samplingParams: false,
  cacheMinTokens: 4096,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  compaction: false,
};

export function capabilitiesFor(model: string): ModelCapabilities {
  return CAPABILITIES[model] ?? UNKNOWN_MODEL;
}

export function isKnownModel(model: string): boolean {
  return model in CAPABILITIES;
}

/**
 * Builds the thinking + effort portion of a request for the given model. Returns only the
 * fields that model accepts, so callers can spread the result without branching.
 */
export function thinkingParamsFor(
  model: string,
  effort: EffortLevel,
  maxTokens: number,
): Record<string, unknown> {
  const caps = capabilitiesFor(model);
  const params: Record<string, unknown> = {};

  if (caps.adaptiveThinking) {
    // `display: 'summarized'` is deliberate. The default is 'omitted', which streams
    // thinking blocks with empty text — the UI would show a long silent pause instead
    // of the agent's reasoning.
    params.thinking = { type: 'adaptive', display: 'summarized' };
  } else {
    // budget_tokens must be strictly less than max_tokens, minimum 1024.
    const budget = Math.max(1024, Math.min(Math.floor(maxTokens / 2), maxTokens - 1024));
    if (budget >= 1024 && budget < maxTokens) {
      params.thinking = { type: 'enabled', budget_tokens: budget };
    }
  }

  if (caps.effort) {
    params.output_config = { effort };
  }

  return params;
}
