/**
 * Per-vendor differences across the OpenAI-compatible `/chat/completions` dialect.
 *
 * These endpoints agree on the shape but disagree on the details, and each disagreement
 * below is one that breaks tool calling outright rather than degrading it. Kept as data so
 * adding a vendor is a row, not a subclass.
 */

export interface VendorModel {
  id: string;
  /** Whatever the vendor calls its context length; names differ. */
  contextLength?: number;
  displayName?: string;
  supportsTools?: boolean;
}

export interface VendorConfig {
  id: string;
  label: string;
  description: string;
  detail: string;
  icon: string;
  docsUrl: string;
  defaultBaseUrl: string;
  defaultModel: string;
  secretKey: string;
  keyPlaceholder: string;
  keyPattern?: string;
  keyPatternWarning?: string;
  fallbackRank: number;
  contextWindow: number;

  /** Extra headers some vendors require for attribution or routing. */
  extraHeaders?: Record<string, string>;

  /** OpenAI's reasoning models reject `max_tokens` and require `max_completion_tokens`. */
  maxTokensField?(model: string): 'max_tokens' | 'max_completion_tokens';

  /** Gemini rejects this outright. */
  supportsParallelToolCalls?: boolean;

  /**
   * Whether `stream_options: { include_usage: true }` is accepted.
   *
   * A streamed response carries no token counts unless this is asked for, so without it
   * the agent reports every run as 0 in / 0 out. Opt-out rather than opt-in: the field is
   * part of the OpenAI spec, and a vendor that rejects it is the exception.
   */
  supportsStreamUsage?: boolean;

  /**
   * Gemini accepts only a narrow JSON-Schema subset; sending our full tool schema is a 400.
   */
  sanitizeToolSchema?: boolean;

  /** Some Nvidia models emit reasoning as `<think>…</think>` inside `content`. */
  stripThinkTags?: boolean;

  /** Narrows a `/models` listing that would otherwise be unusable. */
  filterModels?(model: Record<string, unknown>): boolean;

  /** Maps a raw `/models` entry to the fields the picker needs. */
  parseModel?(model: Record<string, unknown>): VendorModel;
}

const OPENAI_CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;

export const VENDORS: VendorConfig[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT models',
    detail: 'Native tool calling. Requires an OpenAI API key.',
    icon: 'cloud',
    docsUrl: 'https://platform.openai.com/api-keys',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    secretKey: 'repo-intelligence.openai.apiKey',
    keyPlaceholder: 'sk-...',
    keyPattern: '^sk-',
    keyPatternWarning: 'OpenAI keys normally begin with "sk-".',
    fallbackRank: 80,
    contextWindow: 128_000,
    // Sending both fields is a 400, so this picks exactly one.
    maxTokensField: (model) =>
      /^(o\d|gpt-5)/.test(model) ? 'max_completion_tokens' : 'max_tokens',
    // /models also returns embeddings, tts and whisper models, which cannot chat.
    filterModels: (model) => OPENAI_CHAT_MODEL.test(String(model.id ?? '')),
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini models via the OpenAI-compatible endpoint',
    detail: 'Large context windows. Requires a Google AI Studio key.',
    icon: 'cloud',
    docsUrl: 'https://aistudio.google.com/apikey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    secretKey: 'repo-intelligence.gemini.apiKey',
    keyPlaceholder: 'AIza...',
    fallbackRank: 70,
    contextWindow: 1_000_000,
    supportsParallelToolCalls: false,
    sanitizeToolSchema: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Hundreds of models behind one key',
    detail: 'Routes to many providers. Requires an OpenRouter key.',
    icon: 'globe',
    docsUrl: 'https://openrouter.ai/keys',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    secretKey: 'repo-intelligence.openrouter.apiKey',
    keyPlaceholder: 'sk-or-v1-...',
    keyPattern: '^sk-or-',
    keyPatternWarning: 'OpenRouter keys normally begin with "sk-or-".',
    fallbackRank: 60,
    contextWindow: 200_000,
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/repo-intelligence',
      'X-Title': 'Repo Intelligence',
    },
    // Unfiltered this returns hundreds of entries, most without tool support.
    filterModels: (model) => {
      const supported = model.supported_parameters;
      return Array.isArray(supported) && supported.includes('tools');
    },
    parseModel: (model) => ({
      id: String(model.id),
      displayName: typeof model.name === 'string' ? model.name : undefined,
      contextLength: typeof model.context_length === 'number' ? model.context_length : undefined,
      supportsTools: true,
    }),
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Very fast inference',
    detail: 'Open models at high speed. Requires a Groq key.',
    icon: 'zap',
    docsUrl: 'https://console.groq.com/keys',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    secretKey: 'repo-intelligence.groq.apiKey',
    keyPlaceholder: 'gsk_...',
    keyPattern: '^gsk_',
    keyPatternWarning: 'Groq keys normally begin with "gsk_".',
    fallbackRank: 55,
    contextWindow: 128_000,
    parseModel: (model) => ({
      id: String(model.id),
      contextLength: typeof model.context_window === 'number' ? model.context_window : undefined,
    }),
  },
  {
    id: 'nvidia',
    label: 'Nvidia NIM',
    description: 'Models hosted on Nvidia NIM',
    detail: 'Requires an Nvidia API key.',
    icon: 'circuit-board',
    docsUrl: 'https://build.nvidia.com/',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    secretKey: 'repo-intelligence.nvidia.apiKey',
    keyPlaceholder: 'nvapi-...',
    keyPattern: '^nvapi-',
    keyPatternWarning: 'Nvidia keys normally begin with "nvapi-".',
    fallbackRank: 50,
    contextWindow: 128_000,
    // Several NIM models put chain-of-thought in <think> tags inside content.
    stripThinkTags: true,
  },
];

export function vendorById(id: string): VendorConfig | undefined {
  return VENDORS.find((vendor) => vendor.id === id);
}

/**
 * Reduces a tool schema to the subset Gemini's compatibility layer accepts.
 *
 * It rejects `additionalProperties`, `$schema` and `default` outright, so leaving them in
 * fails the whole request rather than the individual tool.
 */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'default') continue;
    output[key] = sanitizeSchema(value);
  }
  return output;
}

/**
 * Splits `<think>` blocks out of streamed content so they surface as reasoning rather than
 * appearing inline in the answer.
 */
export function splitThinkTags(text: string): { thinking: string; content: string } {
  let thinking = '';
  const content = text.replace(/<think>([\s\S]*?)<\/think>/g, (_match, inner: string) => {
    thinking += inner;
    return '';
  });
  return { thinking, content };
}
