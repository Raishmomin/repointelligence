import { Logger } from '../../../shared/Logger';
import { ProviderConfigContext, ProviderHost } from '../descriptor';
import {
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmStopReason,
  LlmToolSchema,
  LlmTurnRequest,
  LlmTurnResult,
} from '../types';
import { parseChunk, readSSE } from './sse';
import { OpenAIToolCallDelta, ToolCallAssembler } from './ToolCallAssembler';
import { sanitizeSchema, splitThinkTags, VendorConfig } from './vendors';

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * One provider covering every OpenAI-compatible backend.
 *
 * OpenAI, Gemini, OpenRouter, Groq and Nvidia NIM all speak the same `/chat/completions`
 * dialect, so the differences live in a `VendorConfig` row rather than in subclasses.
 * Uses raw fetch — the surface needed is small, and the vendor deviations are exactly the
 * things an SDK abstraction would hide.
 */
export class OpenAICompatProvider implements LlmProvider {
  readonly supportsNativeTools = true;

  constructor(
    private readonly vendor: VendorConfig,
    private readonly config: ProviderConfigContext,
    private readonly logger: Logger,
  ) {}

  static create(vendor: VendorConfig, host: ProviderHost): OpenAICompatProvider {
    return new OpenAICompatProvider(vendor, host.config, host.logger);
  }

  get id(): string {
    return this.vendor.id;
  }

  get modelId(): string {
    return this.config.getString('model', this.vendor.defaultModel);
  }

  get contextWindow(): number {
    return this.config.getNumber('contextWindow', this.vendor.contextWindow);
  }

  private get baseUrl(): string {
    return this.config.getString('baseUrl', this.vendor.defaultBaseUrl).replace(/\/$/, '');
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.config.getSecret('apiKey');
    return {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(this.vendor.extraHeaders ?? {}),
    };
  }

  async isAvailable(): Promise<boolean> {
    return !(await this.unavailableReason());
  }

  async unavailableReason(): Promise<string | undefined> {
    const key = await this.config.getSecret('apiKey');
    if (!key) return `No ${this.vendor.label} API key is configured.`;

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: await this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return undefined;
      if (response.status === 401) return `${this.vendor.label} rejected the API key.`;
      return `${this.vendor.label} returned ${response.status}.`;
    } catch (error) {
      return `Could not reach ${this.vendor.label}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Models the vendor offers, filtered and shaped for the picker. */
  async listModels(): Promise<Array<{ id: string; label: string; detail?: string }>> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: await this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${this.vendor.label} returned ${response.status}`);

    const body = (await response.json()) as { data?: Record<string, unknown>[] };
    const raw = body.data ?? [];
    const filtered = this.vendor.filterModels ? raw.filter(this.vendor.filterModels) : raw;

    return filtered
      .map((entry) => {
        const parsed = this.vendor.parseModel?.(entry) ?? { id: String(entry.id) };
        return {
          id: parsed.id,
          label: parsed.displayName ?? parsed.id,
          detail: parsed.contextLength
            ? `${Math.round(parsed.contextLength / 1000)}K context`
            : undefined,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async streamTurn(request: LlmTurnRequest): Promise<LlmTurnResult> {
    const model = this.modelId;
    const assembler = new ToolCallAssembler();

    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: toOpenAIMessages(request.system, request.messages),
      [this.vendor.maxTokensField?.(model) ?? 'max_tokens']: request.maxTokens,
    };

    if (request.tools.length) {
      body.tools = toOpenAITools(request.tools, this.vendor);
      // Gemini rejects this field outright rather than ignoring it.
      if (this.vendor.supportsParallelToolCalls !== false) body.parallel_tool_calls = true;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      throw new Error(await describeFailure(response, this.vendor));
    }

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    let finishReason: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of readSSE(response.body, request.token)) {
      const chunk = parseChunk<StreamChunk>(event.data);
      // A single malformed frame should not abort an otherwise healthy stream.
      if (!chunk) continue;

      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }

      const delta = choice?.delta;
      if (!delta) continue;

      // Some vendors expose reasoning as its own field.
      if (delta.reasoning_content) {
        thinkingParts.push(delta.reasoning_content);
        request.onEvent({ type: 'thinking_delta', text: delta.reasoning_content });
      }

      if (delta.content) {
        if (this.vendor.stripThinkTags) {
          const { thinking, content } = splitThinkTags(delta.content);
          if (thinking) {
            thinkingParts.push(thinking);
            request.onEvent({ type: 'thinking_delta', text: thinking });
          }
          if (content) {
            textParts.push(content);
            request.onEvent({ type: 'text_delta', text: content });
          }
        } else {
          textParts.push(delta.content);
          request.onEvent({ type: 'text_delta', text: delta.content });
        }
      }

      if (delta.tool_calls?.length) {
        assembler.push(delta.tool_calls, request.onEvent);
      }
    }

    if (request.token.isCancellationRequested) {
      return { content: [], stopReason: 'cancelled', usage };
    }

    const { blocks, malformed } = assembler.finish(request.onEvent);
    for (const bad of malformed) {
      this.logger.warn(`${this.vendor.label} sent unparseable arguments for "${bad.name}".`);
    }

    const content: LlmContentBlock[] = [];
    const thinking = thinkingParts.join('');
    if (thinking) content.push({ type: 'thinking', text: thinking });
    const text = textParts.join('');
    if (text) content.push({ type: 'text', text });
    content.push(...blocks);

    return {
      content,
      stopReason: mapFinishReason(finishReason, blocks.length > 0),
      usage,
      // Rebuilt from normalised blocks rather than replayed: this dialect carries no signed
      // or opaque content, so there is nothing that must survive byte-identical.
      raw: { role: 'assistant', content },
    };
  }
}

// ── Mapping ──────────────────────────────────────────────────

/**
 * `finish_reason: "stop"` alongside tool calls means the model wants a tool run — Groq and
 * several Nvidia models report it that way routinely. Trusting `stop` there ends the turn
 * with the tools never executed, which looks like the agent giving up mid-task.
 */
export function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): LlmStopReason {
  if (hasToolCalls) return 'tool_use';
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/**
 * Converts the internal message shape to OpenAI's.
 *
 * Tool results are a separate `role: 'tool'` message per result here, not blocks nested in
 * a user turn — nesting them is accepted by some vendors and silently ignored by others.
 */
export function toOpenAIMessages(
  system: string,
  messages: LlmMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block): block is Extract<LlmContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const toolCalls = message.content
        .filter((block): block is Extract<LlmContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }));

      out.push({
        role: 'assistant',
        // null rather than '' — some vendors reject an empty string alongside tool_calls.
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (typeof message.content === 'string') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    // Fan out: every tool_result becomes its own message, and any plain text follows.
    const textBlocks: string[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
      } else {
        textBlocks.push(block.text);
      }
    }
    if (textBlocks.length) out.push({ role: 'user', content: textBlocks.join('\n\n') });
  }

  return out;
}

export function toOpenAITools(
  tools: LlmToolSchema[],
  vendor: VendorConfig,
): Array<Record<string, unknown>> {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: vendor.sanitizeToolSchema ? sanitizeSchema(tool.inputSchema) : tool.inputSchema,
      },
    }));
}

async function describeFailure(response: Response, vendor: VendorConfig): Promise<string> {
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    return retry
      ? `Rate limited by ${vendor.label} — retry in ${retry}s.`
      : `Rate limited by ${vendor.label}.`;
  }
  if (response.status === 401) return `${vendor.label} rejected the API key.`;

  const body = await response.text().catch(() => '');
  const detail = body.slice(0, 300);
  return `${vendor.label} returned ${response.status}${detail ? `: ${detail}` : ''}`;
}
