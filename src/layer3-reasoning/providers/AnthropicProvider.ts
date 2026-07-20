import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { Logger } from '../../shared/Logger';
import { ANTHROPIC_MODELS, capabilitiesFor, EffortLevel, thinkingParamsFor } from './modelCapabilities';
import {
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmStopReason,
  LlmToolSchema,
  LlmTurnRequest,
  LlmTurnResult,
  ProviderUnavailableError,
} from './types';

export const ANTHROPIC_SECRET_KEY = 'repo-intelligence.anthropic.apiKey';
export const SET_API_KEY_COMMAND = 'repo-intelligence.setApiKey';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly supportsNativeTools = true;

  private client: Anthropic | undefined;
  private cachedKey: string | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly logger: Logger = Logger.getInstance(),
  ) {}

  get contextWindow(): number {
    return capabilitiesFor(this.model).contextWindow;
  }

  /** The model this provider will use, for the status bar and run diagnostics. */
  get modelId(): string {
    return this.model;
  }

  private get model(): string {
    return vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<string>('anthropic.model', ANTHROPIC_MODELS.opus);
  }

  private get effort(): EffortLevel {
    return vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<EffortLevel>('anthropic.effort', 'high');
  }

  /** Drops the cached client so the next call picks up a rotated key. */
  invalidate(): void {
    this.client = undefined;
    this.cachedKey = undefined;
  }

  async isAvailable(): Promise<boolean> {
    return !!(await this.secrets.get(ANTHROPIC_SECRET_KEY));
  }

  async unavailableReason(): Promise<string | undefined> {
    if (await this.isAvailable()) return undefined;
    return 'No Anthropic API key is configured. Run "Repo Intelligence: Set Anthropic API Key".';
  }

  private async getClient(): Promise<Anthropic> {
    const key = await this.secrets.get(ANTHROPIC_SECRET_KEY);
    if (!key) {
      throw new ProviderUnavailableError(
        'No Anthropic API key is configured.',
        SET_API_KEY_COMMAND,
      );
    }
    if (!this.client || this.cachedKey !== key) {
      this.client = new Anthropic({ apiKey: key });
      this.cachedKey = key;
    }
    return this.client;
  }

  async streamTurn(request: LlmTurnRequest): Promise<LlmTurnResult> {
    const client = await this.getClient();
    const model = this.model;
    const caps = capabilitiesFor(model);
    const maxTokens = Math.min(request.maxTokens, caps.maxOutputTokens);

    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: buildSystem(request.system),
      messages: toAnthropicMessages(request.messages),
      tools: toAnthropicTools(request.tools),
      ...thinkingParamsFor(model, this.effort, maxTokens),
    });

    // The SDK reassembles partial tool JSON itself; the fragments are forwarded purely so
    // the webview can render arguments as they arrive.
    stream.on('text', (delta: string) => request.onEvent({ type: 'text_delta', text: delta }));

    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          request.onEvent({ type: 'tool_use_start', id: block.id, name: block.name });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'thinking_delta') {
          request.onEvent({ type: 'thinking_delta', text: delta.thinking });
        } else if (delta.type === 'input_json_delta') {
          request.onEvent({ type: 'tool_use_input', id: String(event.index), partialJson: delta.partial_json });
        }
      } else if (event.type === 'content_block_stop') {
        request.onEvent({ type: 'tool_use_end', id: String(event.index) });
      }
    });

    const cancellation = request.token.onCancellationRequested(() => stream.abort());

    try {
      const message = await stream.finalMessage();
      const usage = message.usage;

      // A persistently zero cache read means something volatile leaked into the prefix.
      if (usage.cache_read_input_tokens === 0 && usage.cache_creation_input_tokens === 0) {
        this.logger.debug('Anthropic: no prompt cache activity this turn');
      }

      return {
        content: normalizeContent(message.content),
        stopReason: mapStopReason(message.stop_reason),
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
        },
        // Replayed verbatim next turn — thinking blocks must go back unmodified.
        raw: { role: 'assistant', content: message.content },
      };
    } catch (error) {
      if (request.token.isCancellationRequested) {
        return { content: [], stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      const message = error instanceof Error ? error.message : String(error);
      request.onEvent({ type: 'error', message });
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  async countTokens(system: string, messages: LlmMessage[], tools: LlmToolSchema[]): Promise<number> {
    const client = await this.getClient();
    const result = await client.messages.countTokens({
      model: this.model,
      system: buildSystem(system),
      messages: toAnthropicMessages(messages),
      tools: toAnthropicTools(tools),
    });
    return result.input_tokens;
  }
}

// ── Request construction ─────────────────────────────────────

/**
 * Render order is tools → system → messages, so a breakpoint on the system block caches
 * the tool definitions with it.
 */
function buildSystem(system: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/**
 * Tools render at position 0 of the cached prefix, so the array must be byte-stable across
 * a run — sorted by name here, and never varied per mode by callers. The breakpoint goes on
 * the last definition so the whole block caches together.
 */
function toAnthropicTools(tools: LlmToolSchema[]): Anthropic.Tool[] {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    ...(index === sorted.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return { role: 'assistant', content: message.content.map(toAnthropicBlock) };
    }
    if (typeof message.content === 'string') {
      return { role: 'user', content: message.content };
    }
    return {
      role: 'user',
      content: message.content.map((block) =>
        block.type === 'tool_result'
          ? {
              type: 'tool_result' as const,
              tool_use_id: block.toolUseId,
              content: block.content,
              ...(block.isError ? { is_error: true } : {}),
            }
          : { type: 'text' as const, text: block.text },
      ),
    };
  });
}

function toAnthropicBlock(block: LlmContentBlock): Anthropic.ContentBlockParam {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  // Thinking blocks are only ever replayed via `raw`; a reconstructed one would fail
  // signature validation, so degrade to text rather than forge one.
  return { type: 'text', text: block.text };
}

// ── Response normalisation ───────────────────────────────────

export function normalizeContent(content: Anthropic.ContentBlock[]): LlmContentBlock[] {
  const blocks: LlmContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', text: block.thinking });
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return blocks;
}

export function mapStopReason(reason: string | null): LlmStopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}
