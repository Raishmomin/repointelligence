import * as vscode from 'vscode';
import { Logger } from '../../shared/Logger';
import { OllamaClient } from '../ollama/OllamaClient';
import { describeToolsForPrompt, parseOllamaEnvelope } from './ollamaEnvelope';
import { assessModel } from './ollamaModels';
import { ModelCompletion } from '../../shared/types/agent.types';
import {
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmTextBlock,
  LlmToolResultBlock,
  LlmTurnRequest,
  LlmTurnResult,
} from './types';

/**
 * Local-model provider.
 *
 * Ollama's tool-calling support varies enormously by model, so this always uses the
 * JSON-envelope protocol: it works on every model, and one predictable path is easier to
 * reason about than a capability probe that silently changes behaviour. Synthetic
 * streaming events are emitted so the agent loop and webview cannot tell the two providers
 * apart.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly supportsNativeTools = false;

  /** Last model warned about, so the notification does not repeat every availability check. */
  private warnedAboutModel: string | undefined;

  constructor(
    private readonly client: OllamaClient,
    private readonly logger: Logger = Logger.getInstance(),
  ) {}

  get contextWindow(): number {
    return vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<number>('ollama.contextWindow', 16_384);
  }

  /** How long Ollama holds the model in memory once a turn finishes. */
  get keepAlive(): string {
    return vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<string>('ollama.keepAlive', '30m');
  }

  /** The model this provider will actually use, for the status bar and run diagnostics. */
  get modelId(): string {
    return vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<string>('ollama.chatModel', 'qwen2.5-coder:7b');
  }

  async isAvailable(): Promise<boolean> {
    const health = await this.client.checkHealth();
    if (health.available) this.warnIfModelTooSmall();
    return health.available;
  }

  /**
   * Warns once per model about a model too small to drive the agent.
   *
   * Worth surfacing loudly: the symptom is the agent asking the user where files are, which
   * reads as a broken extension rather than an under-powered model.
   */
  private warnIfModelTooSmall(): void {
    const model = this.modelId;
    if (this.warnedAboutModel === model) return;
    this.warnedAboutModel = model;

    const assessment = assessModel(model);
    if (assessment.fitness === 'good' || !assessment.warning) return;

    this.logger.warn(assessment.warning);
    if (assessment.fitness === 'poor') {
      vscode.window
        .showWarningMessage(assessment.warning, 'Choose a different model')
        .then((choice) => {
          if (choice) {
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'repo-intelligence.ollama.chatModel',
            );
          }
        });
    }
  }

  async unavailableReason(): Promise<string | undefined> {
    const health = await this.client.checkHealth();
    if (health.available) return undefined;
    return `Ollama is not reachable at ${health.url}. ${health.error ?? ''}`.trim();
  }

  async streamTurn(request: LlmTurnRequest): Promise<LlmTurnResult> {
    const allowedTools = request.tools.map((tool) => tool.name);
    const system = request.system + describeToolsForPrompt(request.tools);
    const messages = [{ role: 'system', content: system }, ...flattenMessages(request.messages)];

    let completion: ModelCompletion;
    try {
      completion = await this.client.chatComplete(messages, {
        // Sourced from the same getter the agent's TranscriptManager budgets against, so
        // the window Ollama enforces and the window we pack for are always one number.
        numCtx: this.contextWindow,
        maxTokens: request.maxTokens,
        keepAlive: this.keepAlive,
      });
    } catch (error) {
      if (request.token.isCancellationRequested) {
        return { content: [], stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      const message = error instanceof Error ? error.message : String(error);
      request.onEvent({ type: 'error', message });
      throw error;
    }

    if (request.token.isCancellationRequested) {
      return { content: [], stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
    }

    const raw = completion.content;
    const { blocks, hasToolCalls } = parseOllamaEnvelope(raw, allowedTools);
    if (!hasToolCalls && raw.includes('"toolCalls"')) {
      // The model tried to call a tool and produced something unusable. Worth surfacing:
      // it usually means the model is too small for the protocol.
      this.logger.warn('Ollama returned toolCalls that could not be parsed; treating as text.');
    }

    // Replay the completed response as stream events so downstream consumers see the same
    // shape they get from a genuinely streaming provider.
    emitSynthetic(blocks, request);

    return {
      content: blocks,
      stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
      usage: { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens },
      raw: { role: 'assistant', content: blocks },
    };
  }
}

function emitSynthetic(blocks: LlmContentBlock[], request: LlmTurnRequest): void {
  for (const block of blocks) {
    if (block.type === 'text') {
      request.onEvent({ type: 'text_delta', text: block.text });
    } else if (block.type === 'thinking') {
      request.onEvent({ type: 'thinking_delta', text: block.text });
    } else {
      request.onEvent({ type: 'tool_use_start', id: block.id, name: block.name });
      request.onEvent({ type: 'tool_use_input', id: block.id, partialJson: JSON.stringify(block.input) });
      request.onEvent({ type: 'tool_use_end', id: block.id });
    }
  }
}

/**
 * Ollama takes flat {role, content} strings, so structured blocks are rendered to text.
 * Tool results keep their id in the rendered output — without it a model juggling several
 * parallel calls cannot tell which result belongs to which request.
 */
function flattenMessages(messages: LlmMessage[]): { role: string; content: string }[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return { role: 'assistant', content: renderAssistant(message.content) };
    }
    if (typeof message.content === 'string') {
      return { role: 'user', content: message.content };
    }
    return { role: 'user', content: message.content.map(renderUserBlock).join('\n\n') };
  });
}

function renderAssistant(blocks: LlmContentBlock[]): string {
  const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
  const calls = blocks.filter((b): b is Extract<LlmContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
  const envelope: Record<string, unknown> = {};
  if (text.length) envelope.response = text.join('\n');
  if (calls.length) {
    envelope.toolCalls = calls.map((c) => ({ id: c.id, name: c.name, arguments: c.input }));
  }
  return JSON.stringify(envelope);
}

function renderUserBlock(block: LlmTextBlock | LlmToolResultBlock): string {
  if (block.type === 'tool_result') {
    const status = block.isError ? 'ERROR' : 'OK';
    return `[TOOL RESULT ${block.toolUseId} ${status}]\n${block.content}`;
  }
  return block.text;
}
