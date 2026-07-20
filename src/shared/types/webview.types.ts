import type { WireProviderSchema } from '../../layer3-reasoning/providers/descriptor.types';

/**
 * The contract between the extension host and the sidebar UI.
 *
 * Imported by **both** sides, so adding a variant is a compile error in the handler that
 * forgot it. Everything here must survive `postMessage` structured cloning: plain data
 * only, no class instances, no functions, no `undefined` inside arrays.
 */

// ── Agent timeline ───────────────────────────────────────────

/**
 * One step of an agent run, pre-batched by `AgentStreamBridge`.
 *
 * Lives here rather than beside the bridge so the webview can import it without reaching
 * into the extension host's module graph.
 */
export type AgentStreamStep =
  | { kind: 'turn'; turn: number; maxTurns: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      toolCallId: string;
      name: string;
      status: 'running' | 'ok' | 'error';
      preview?: string;
    }
  | { kind: 'approval'; changeSetIds: string[]; commandIds: string[] }
  | {
      kind: 'finished';
      status: string;
      turns: number;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    }
  | { kind: 'error'; message: string };

// ── View models ──────────────────────────────────────────────

export type TaskModeDto = 'implement' | 'plan' | 'explain';

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface SessionDto {
  id: string;
  title: string;
  createdAt: number;
}

export interface ModelOptionDto {
  providerId: string;
  providerLabel: string;
  /** Codicon id for the provider. */
  icon?: string;
  modelId: string;
  label: string;
  detail?: string;
  /** False when the provider still needs an API key or is unreachable. */
  available: boolean;
}

export interface ModelStateDto {
  activeProviderId: string;
  activeProviderLabel: string;
  activeModelId?: string;
  mode: TaskModeDto;
  /** Set when the last run was served by something other than the configured provider. */
  fallbackFrom?: string;
}

export interface ProviderSummaryDto {
  schema: WireProviderSchema;
  configured: boolean;
  /** Which secret fields already hold a value. Values themselves are never sent. */
  storedSecrets: Record<string, boolean>;
  /** Currently persisted non-secret settings, to prefill the form. */
  values: Record<string, string | number>;
}

export interface PendingApprovalDto {
  changeSetId?: string;
  commandId?: string;
  summary: string;
  /** Files touched, for the diff cards. */
  paths: string[];
  risk: string;
}

// ── Host → webview ───────────────────────────────────────────

export type ExtensionToWebview =
  | { type: 'status'; status: string; message?: string }
  | { type: 'projectInfo'; name: string; framework: string }
  | { type: 'sessions'; sessions: SessionDto[]; activeSessionId: string | null }
  | { type: 'messages'; messages: ChatMessageDto[] }
  | { type: 'streamChunk'; chunk: string }
  | { type: 'contextInfo'; summary: string }
  | { type: 'agentTimeline'; content: string }
  | { type: 'agentStream'; runId: string; steps: AgentStreamStep[] }
  | { type: 'modelState'; state: ModelStateDto; models: ModelOptionDto[] }
  | { type: 'providers'; providers: ProviderSummaryDto[] }
  | { type: 'approvals'; approvals: PendingApprovalDto[] }
  | { type: 'error'; message: string }
  /** Reply to a correlated request. `ok:false` carries the failure message. */
  | { type: 'rpcResponse'; requestId: string; ok: boolean; payload?: unknown; error?: string };

// ── Webview → host ───────────────────────────────────────────

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'sendMessage'; text: string }
  | { type: 'sendAgentMessage'; text: string; mode: TaskModeDto }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'cancelRun' }
  | { type: 'setMode'; mode: TaskModeDto }
  | { type: 'selectModel'; providerId: string; modelId: string }
  | { type: 'approveChangeSet'; changeSetId: string }
  | { type: 'rejectChangeSet'; changeSetId: string }
  | { type: 'approveCommand'; commandId: string }
  | { type: 'rejectCommand'; commandId: string }
  | { type: 'openDiff'; changeSetId: string; path: string }
  | { type: 'refreshModels' }
  /** Correlated request; the host always replies with a matching `rpcResponse`. */
  | { type: 'rpcRequest'; requestId: string; method: RpcMethod; params: unknown };

export type RpcMethod = 'providers:list' | 'providers:listModels' | 'providers:validate' | 'providers:save';

export interface ListModelsParams {
  providerId: string;
  fieldId: string;
  draft: Record<string, string | number | undefined>;
}

export interface ValidateParams {
  providerId: string;
  draft: Record<string, string | number | undefined>;
}

export interface SaveParams {
  providerId: string;
  draft: Record<string, string | number | undefined>;
}

// ── Exhaustiveness ───────────────────────────────────────────

/**
 * Compile-time proof that a switch covers every variant.
 *
 * Callers must catch this rather than let it propagate: a webview bundle cached from an
 * earlier version can receive a message its switch does not know, and an uncaught throw
 * there takes down the whole panel instead of skipping one message.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
