import { ToolCall } from '../../shared/types/agent.types';

export interface AgentEnvelope { response?: string; toolCalls?: ToolCall[]; }

/** Parses the only model wire format accepted by the agent. Invalid JSON is a safe text-only response. */
export function parseAgentEnvelope(raw: string): AgentEnvelope {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    const value = parsed as { response?: unknown; toolCalls?: unknown };
    const response = typeof value.response === 'string' ? value.response : undefined;
    const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls.filter(isToolCall) : [];
    if (!response && toolCalls.length === 0) throw new Error('empty envelope');
    return { response, toolCalls };
  } catch { return { response: raw }; }
}

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Record<string, unknown>;
  return typeof call.id === 'string' && typeof call.name === 'string' && !!call.arguments && typeof call.arguments === 'object'
    && ['read_file', 'search_files', 'query_index', 'propose_changes', 'propose_command'].includes(call.name);
}
