import * as vscode from 'vscode';

/**
 * Provider-agnostic LLM surface for the agent loop.
 *
 * Shaped as an event stream rather than a promise because the two providers deliver
 * tool calls differently: Anthropic streams tool arguments as partial JSON fragments
 * (`input_json_delta`) while Ollama emits one complete blob at the end. Normalising to
 * events lets the loop — and the webview — treat both identically.
 */

/**
 * Open by design: providers are contributed through the registry, so adding one must not
 * require editing a union here. Unknown ids are caught at lookup — `ProviderRegistry.require`
 * throws listing the valid ids, and the factory falls back to the top-ranked provider rather
 * than crashing on a typo in settings.
 */
export type ProviderId = string;

// ── Tool schemas ─────────────────────────────────────────────

export interface LlmToolSchema {
  name: string;
  description: string;
  /** JSON Schema (draft-07 subset) describing the tool arguments. */
  inputSchema: Record<string, unknown>;
}

// ── Content blocks ───────────────────────────────────────────

export interface LlmTextBlock {
  type: 'text';
  text: string;
}

export interface LlmThinkingBlock {
  type: 'thinking';
  text: string;
}

export interface LlmToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmContentBlock = LlmTextBlock | LlmThinkingBlock | LlmToolUseBlock;

export interface LlmToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type LlmMessage =
  | { role: 'user'; content: string | Array<LlmTextBlock | LlmToolResultBlock> }
  | { role: 'assistant'; content: LlmContentBlock[] };

// ── Turn results ─────────────────────────────────────────────

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'cancelled';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface LlmTurnResult {
  /** Normalised blocks with tool inputs already parsed. */
  content: LlmContentBlock[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /**
   * The provider's own representation of this assistant turn, replayed verbatim on the
   * next request. Anthropic requires thinking blocks to be echoed back byte-identical,
   * so reconstructing the turn from `content` would eventually fail signature validation.
   * Server-side compaction depends on this too: the compaction block it returns has to
   * go back unchanged or the compacted history is silently lost.
   */
  raw?: unknown;
}

// ── Streaming events ─────────────────────────────────────────

export type LlmStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; partialJson: string }
  | { type: 'tool_use_end'; id: string }
  | { type: 'error'; message: string };

// ── Request ──────────────────────────────────────────────────

export interface LlmTurnRequest {
  system: string;
  messages: LlmMessage[];
  /** Must be sorted by name and stable across a run, or prompt caching never hits. */
  tools: LlmToolSchema[];
  maxTokens: number;
  onEvent: (event: LlmStreamEvent) => void;
  token: vscode.CancellationToken;
}

// ── Provider ─────────────────────────────────────────────────

export interface LlmProvider {
  readonly id: ProviderId;
  /**
   * False when tool calls are recovered by parsing a JSON envelope out of the response
   * rather than from a structured tool-call field. The loop is more forgiving of
   * malformed output in that case.
   */
  readonly supportsNativeTools: boolean;
  readonly contextWindow: number;

  /**
   * The concrete model this provider will use right now — for the status bar and for
   * recording which model actually served a run. Optional so existing implementations and
   * test doubles are unaffected.
   */
  readonly modelId?: string;

  /** Whether the provider is configured and reachable. Never throws. */
  isAvailable(): Promise<boolean>;

  /** Human-readable reason `isAvailable()` returned false, for surfacing to the user. */
  unavailableReason(): Promise<string | undefined>;

  streamTurn(request: LlmTurnRequest): Promise<LlmTurnResult>;

  countTokens?(system: string, messages: LlmMessage[], tools: LlmToolSchema[]): Promise<number>;

  /**
   * Only Ollama implements this — the Anthropic API has no embeddings endpoint, so
   * semantic search always needs a local Ollama regardless of the chat provider.
   */
  embed?(texts: string[]): Promise<Float32Array[]>;
}

// ── Errors ───────────────────────────────────────────────────

/** Raised when a provider cannot run because it has not been configured. */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly remedyCommand?: string,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
