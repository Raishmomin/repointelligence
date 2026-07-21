import { beforeEach, describe, expect, it } from 'vitest';
import { __resetConfig, __setConfig } from '../mocks/vscode';
import { OllamaProvider } from '../../src/layer3-reasoning/providers/OllamaProvider';
import { ModelClientOptions, ModelCompletion } from '../../src/shared/types/agent.types';
import { LlmTurnRequest } from '../../src/layer3-reasoning/providers/types';

/**
 * Records what the provider asks the client for.
 *
 * These options are the whole point of the test: Ollama defaults to a ~4k context and
 * silently truncates the front of the prompt — where the system prompt and tool catalogue
 * live — so a provider that forgets to send `num_ctx` produces a model that behaves as
 * though it had no tools, with no error anywhere to show for it.
 */
class RecordingClient {
  lastOptions: ModelClientOptions | undefined;

  constructor(
    private readonly reply = '{"response":"ok"}',
    private readonly usage = { inputTokens: 0, outputTokens: 0 },
  ) {}

  async chatComplete(
    _messages: { role: string; content: string }[],
    options: ModelClientOptions,
  ): Promise<ModelCompletion> {
    this.lastOptions = options;
    return { content: this.reply, ...this.usage };
  }
}

function request(overrides: Partial<LlmTurnRequest> = {}): LlmTurnRequest {
  return {
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'where is the footer?' }],
    tools: [],
    maxTokens: 16_000,
    token: { isCancellationRequested: false } as LlmTurnRequest['token'],
    onEvent: () => {},
    ...overrides,
  };
}

async function optionsFor(request_: LlmTurnRequest): Promise<ModelClientOptions> {
  const client = new RecordingClient();
  const provider = new OllamaProvider(client as never);
  await provider.streamTurn(request_);
  if (!client.lastOptions) throw new Error('chatComplete was never called');
  return client.lastOptions;
}

describe('OllamaProvider runtime options', () => {
  beforeEach(() => {
    __resetConfig();
  });

  it('sends a context window so Ollama does not fall back to its own small default', async () => {
    const options = await optionsFor(request());
    expect(options.numCtx).toBe(16_384);
  });

  it('sends the context window the transcript is budgeted against', async () => {
    // TranscriptManager compacts at 70% of provider.contextWindow. If num_ctx were a
    // different number, the agent would pack a prompt Ollama then truncates.
    __setConfig('repo-intelligence.ollama.contextWindow', 8_192);

    const provider = new OllamaProvider(new RecordingClient() as never);
    const options = await optionsFor(request());

    expect(options.numCtx).toBe(8_192);
    expect(options.numCtx).toBe(provider.contextWindow);
  });

  it('keeps the model resident between turns', async () => {
    const options = await optionsFor(request());
    expect(options.keepAlive).toBe('30m');
  });

  it('honours a configured keep-alive', async () => {
    __setConfig('repo-intelligence.ollama.keepAlive', '-1');
    const options = await optionsFor(request());
    expect(options.keepAlive).toBe('-1');
  });

  it('caps generation at the turn budget', async () => {
    const options = await optionsFor(request({ maxTokens: 4_000 }));
    expect(options.maxTokens).toBe(4_000);
  });
});

describe('OllamaProvider usage reporting', () => {
  beforeEach(() => {
    __resetConfig();
  });

  it('reports the token counts Ollama returned', async () => {
    // These were previously hardcoded to zero, so every local run rendered as
    // "0 in, 0 out" in the timeline regardless of how much context it actually read.
    const client = new RecordingClient('{"response":"ok"}', { inputTokens: 1234, outputTokens: 56 });
    const provider = new OllamaProvider(client as never);

    const result = await provider.streamTurn(request());

    expect(result.usage.inputTokens).toBe(1234);
    expect(result.usage.outputTokens).toBe(56);
  });

  it('treats a backend that reports nothing as zero rather than failing', async () => {
    const client = new RecordingClient('{"response":"ok"}', { inputTokens: 0, outputTokens: 0 });
    const provider = new OllamaProvider(client as never);

    const result = await provider.streamTurn(request());

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
