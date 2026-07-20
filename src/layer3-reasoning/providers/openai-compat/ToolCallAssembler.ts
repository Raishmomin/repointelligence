import { LlmStreamEvent, LlmToolUseBlock } from '../types';

export interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface Accumulator {
  index: number;
  id: string;
  name: string;
  args: string;
  started: boolean;
}

/**
 * Reassembles tool calls from an OpenAI-compatible stream.
 *
 * Tool calls arrive as fragments spread across chunks, and three details decide whether
 * this works at all:
 *
 *  - Accumulators are keyed by **index, never by id**. `id` appears only on the first
 *    fragment, and Gemini's compatibility layer and several Nvidia NIM models omit it
 *    entirely — keying by id silently drops every call from those vendors.
 *  - The function **name is appended, not assigned**. Some vendors fragment it, so
 *    assigning keeps only the last piece ("file" out of "read_" + "file") and every call
 *    then fails tool-name validation.
 *  - A missing id is **synthesised and stable**. The agent loop pairs `tool_result` to
 *    `tool_use` by id, so an unstable or colliding id pairs a result with the wrong call.
 */
export class ToolCallAssembler {
  private readonly byIndex = new Map<number, Accumulator>();

  /** Distinguishes synthesised ids across turns so they cannot collide in a transcript. */
  constructor(private readonly nonce: string = Math.random().toString(36).slice(2, 8)) {}

  push(deltas: OpenAIToolCallDelta[], emit: (event: LlmStreamEvent) => void): void {
    for (const delta of deltas) {
      const index = delta.index ?? 0;

      let accumulator = this.byIndex.get(index);
      if (!accumulator) {
        accumulator = { index, id: '', name: '', args: '', started: false };
        this.byIndex.set(index, accumulator);
      }

      if (delta.id) accumulator.id = delta.id;
      if (delta.function?.name) accumulator.name += delta.function.name;
      if (delta.function?.arguments) accumulator.args += delta.function.arguments;

      if (!accumulator.id && accumulator.name) {
        accumulator.id = `call_${this.nonce}_${index}`;
      }

      // Announced once, as soon as there is enough to name it.
      if (!accumulator.started && accumulator.name && accumulator.id) {
        accumulator.started = true;
        emit({ type: 'tool_use_start', id: accumulator.id, name: accumulator.name });
      }
      if (accumulator.started && delta.function?.arguments) {
        emit({
          type: 'tool_use_input',
          id: accumulator.id,
          partialJson: delta.function.arguments,
        });
      }
    }
  }

  /**
   * Closes every call and returns the parsed blocks.
   *
   * @returns `malformed` names any call whose arguments did not parse, so the caller can
   *          report it to the model rather than dropping it silently.
   */
  finish(emit: (event: LlmStreamEvent) => void): {
    blocks: LlmToolUseBlock[];
    malformed: Array<{ name: string; args: string }>;
  } {
    const blocks: LlmToolUseBlock[] = [];
    const malformed: Array<{ name: string; args: string }> = [];

    // Sorted by index so the order matches what the model emitted. The agent loop answers
    // tool calls in their original order; Map iteration is insertion-ordered, which is
    // usually the same but is not guaranteed when a vendor interleaves indices.
    const ordered = [...this.byIndex.values()].sort((a, b) => a.index - b.index);

    for (const accumulator of ordered) {
      if (!accumulator.name) continue;
      if (accumulator.started) emit({ type: 'tool_use_end', id: accumulator.id });

      const input = parseArguments(accumulator.args);
      if (input === undefined) {
        malformed.push({ name: accumulator.name, args: accumulator.args });
        continue;
      }

      blocks.push({ type: 'tool_use', id: accumulator.id, name: accumulator.name, input });
    }

    return { blocks, malformed };
  }

  get hasCalls(): boolean {
    return this.byIndex.size > 0;
  }
}

/**
 * A tool taking no arguments legitimately streams `""`, `"{}"`, or nothing at all.
 * `JSON.parse("")` throws, so without this every no-argument tool call is dropped.
 */
function parseArguments(args: string): Record<string, unknown> | undefined {
  const trimmed = args.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
