import { LlmContentBlock, LlmToolSchema } from './types';

/**
 * Fallback protocol for local models without native tool calling.
 *
 * The model is asked to emit a single JSON object; this parses it into the same content
 * blocks a native tool-calling provider would produce. Pure and dependency-free so the
 * failure modes — truncated JSON, hallucinated tool names, arguments that arrive as a
 * string instead of an object — can be tested directly.
 *
 * The guiding rule is that malformed output degrades to plain text. A phantom tool call
 * invented from garbage is far worse than a missed one: the agent would act on arguments
 * the model never meant to send.
 */

export interface ParsedEnvelope {
  blocks: LlmContentBlock[];
  /** True when at least one well-formed tool call was recovered. */
  hasToolCalls: boolean;
}

export function parseOllamaEnvelope(raw: string, allowedTools: readonly string[]): ParsedEnvelope {
  const source = extractJsonObject(raw);
  if (!source) return textOnly(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return textOnly(raw);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return textOnly(raw);

  const value = parsed as { response?: unknown; toolCalls?: unknown };
  const blocks: LlmContentBlock[] = [];

  if (typeof value.response === 'string' && value.response.trim()) {
    blocks.push({ type: 'text', text: value.response });
  }

  let index = 0;
  const calls = Array.isArray(value.toolCalls) ? value.toolCalls : [];
  for (const candidate of calls) {
    const call = toToolUse(candidate, allowedTools, index);
    if (call) {
      blocks.push(call);
      index++;
    }
  }

  // A parsed object that yielded nothing usable is not a successful parse — fall back to
  // the raw text so the user at least sees what the model said.
  if (blocks.length === 0) return textOnly(raw);

  return { blocks, hasToolCalls: index > 0 };
}

function toToolUse(
  candidate: unknown,
  allowedTools: readonly string[],
  index: number,
): LlmContentBlock | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const call = candidate as { id?: unknown; name?: unknown; arguments?: unknown };

  if (typeof call.name !== 'string' || !allowedTools.includes(call.name)) return undefined;

  const input = coerceArguments(call.arguments);
  if (!input) return undefined;

  return {
    type: 'tool_use',
    // Local models routinely omit or duplicate ids; a positional id keeps tool_use and
    // tool_result pairing correct regardless.
    id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`,
    name: call.name,
    input,
  };
}

/** Accepts an object, or a JSON string containing one — small models often double-encode. */
function coerceArguments(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  // A tool with no arguments is legitimate; anything else is malformed.
  return value === undefined || value === null ? {} : undefined;
}

/**
 * Pulls the outermost JSON object out of a response, tolerating the prose and markdown
 * fences local models wrap around it even when asked for JSON only.
 */
function extractJsonObject(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  return body.slice(start, end + 1);
}

function textOnly(raw: string): ParsedEnvelope {
  return { blocks: raw.trim() ? [{ type: 'text', text: raw }] : [], hasToolCalls: false };
}

/**
 * Describes the tool set inside the system prompt for models that cannot take a native
 * tool schema. Sorted by name to match the native path and keep the prefix stable.
 */
export function describeToolsForPrompt(tools: LlmToolSchema[]): string {
  if (!tools.length) return '';
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const described = sorted
    .map((tool) => `- ${tool.name}: ${tool.description}\n  arguments: ${JSON.stringify(tool.inputSchema)}`)
    .join('\n');

  return [
    '',
    'You have access to the following tools:',
    described,
    '',
    'Reply with ONLY a single JSON object in this exact shape:',
    '{"response":"text for the user","toolCalls":[{"id":"unique-id","name":"tool_name","arguments":{}}]}',
    'Omit toolCalls entirely when no tool is needed. Never wrap the JSON in prose or code fences.',
  ].join('\n');
}
