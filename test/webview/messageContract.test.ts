import { describe, expect, it } from 'vitest';
import type {
  ChatMessageDto,
  ExtensionToWebview,
  SessionDto,
  WebviewToExtension,
} from '../../src/shared/types/webview.types';

/**
 * The host and the webview are separately compiled bundles talking over `postMessage`, so
 * nothing at runtime checks that the shapes agree.
 *
 * `postToWebview` used to be typed `any`, which is exactly how a message declaring
 * `timestamp` reached a webview reading `createdAt`, and a `sessions` payload carrying
 * `created_at` reached one reading `createdAt`. Both compiled cleanly and produced messages
 * that rendered blank or with colliding React keys.
 *
 * These are compile-time assertions: if the protocol drifts from what the mappers produce,
 * this file stops building.
 */
describe('host → webview message contract', () => {
  it('requires the fields the webview actually reads on a message', () => {
    // React keys off `id` and formats `createdAt`; a row shape with `created_at` must not
    // satisfy this type.
    const message: ChatMessageDto = {
      id: 'm1',
      role: 'user',
      content: 'hello',
      createdAt: 1,
    };
    expect(message.id).toBe('m1');

    // @ts-expect-error — snake_case row shapes must not pass as DTOs.
    const wrong: ChatMessageDto = { role: 'user', content: 'x', created_at: 1 };
    expect(wrong).toBeDefined();
  });

  it('requires camelCase on sessions too', () => {
    const session: SessionDto = { id: 's1', title: 'Session', createdAt: 1, updatedAt: 2 };
    expect(session.createdAt).toBe(1);

    // @ts-expect-error — this was the live bug: the host posted the raw database row.
    const wrong: SessionDto = { id: 's1', title: 'Session', created_at: 1, updated_at: 2 };
    expect(wrong).toBeDefined();
  });

  it('covers every message the host actually sends', () => {
    // One of each, so a variant removed from the union breaks the build here rather than
    // silently becoming a message the webview drops.
    const samples: ExtensionToWebview[] = [
      { type: 'status', status: 'idle' },
      { type: 'projectInfo', name: 'repo', framework: 'node' },
      { type: 'sessions', sessions: [], activeSessionId: null },
      { type: 'messages', messages: [] },
      { type: 'streamChunk', chunk: 'x' },
      { type: 'contextInfo', files: ['a.ts'], tokensUsed: 10 },
      { type: 'agentTimeline', content: 'log' },
      { type: 'ollamaHealth', health: { available: true, url: 'http://x', error: null } },
      { type: 'agentStream', runId: 'r1', steps: [] },
      {
        type: 'modelState',
        state: { activeProviderId: 'a', activeProviderLabel: 'A', mode: 'implement' },
        models: [],
      },
      { type: 'providers', providers: [] },
      { type: 'approvals', approvals: [] },
      { type: 'error', message: 'boom' },
      { type: 'rpcResponse', requestId: 'r', ok: true },
    ];

    expect(new Set(samples.map((sample) => sample.type)).size).toBe(samples.length);
  });

  it('covers every message the webview actually sends', () => {
    // The outbound mirror of the registry above. This direction had no coverage at all,
    // which is how a variant could be handled by the host but never sendable — or the
    // reverse — without anything failing.
    const samples: WebviewToExtension[] = [
      { type: 'ready' },
      { type: 'sendMessage', text: 'hello' },
      { type: 'sendAgentMessage', text: 'hello', mode: 'implement' },
      { type: 'newSession' },
      { type: 'selectSession', sessionId: 's1' },
      { type: 'deleteSession', sessionId: 's1' },
      { type: 'cancelRun' },
      { type: 'retryMessage' },
      { type: 'setMode', mode: 'plan' },
      { type: 'selectModel', providerId: 'ollama', modelId: 'qwen2.5-coder:7b' },
      { type: 'approveChangeSet', changeSetId: 'c1' },
      { type: 'rejectChangeSet', changeSetId: 'c1' },
      { type: 'approveCommand', commandId: 'k1' },
      { type: 'rejectCommand', commandId: 'k1' },
      { type: 'openDiff', changeSetId: 'c1', path: 'src/a.ts' },
      { type: 'refreshModels' },
      { type: 'rpcRequest', requestId: 'r', method: 'providers:list', params: {} },
    ];

    expect(new Set(samples.map((sample) => sample.type)).size).toBe(samples.length);
  });

  it('keeps every payload structured-clone safe', () => {
    // postMessage clones; a class instance or function would throw at runtime.
    const message: ExtensionToWebview = {
      type: 'agentStream',
      runId: 'r1',
      steps: [
        {
          kind: 'tool',
          toolCallId: 't1',
          name: 'glob',
          status: 'ok',
          preview: 'x',
          args: 'pattern: **/*footer*',
          output: 'Footer.tsx',
        },
      ],
    };
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });
});
