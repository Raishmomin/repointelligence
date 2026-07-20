import { EventBus } from '../../shared/EventBus';

/**
 * One agent-loop step as the UI needs to render it.
 *
 * Deliberately flat and serialisable: this crosses the extension-host/webview boundary via
 * postMessage, and is the same shape the React rebuild will consume.
 */
export type AgentStreamStep =
  | { kind: 'turn'; turn: number; maxTurns: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCallId: string; name: string; status: 'running' | 'ok' | 'error'; preview?: string }
  | { kind: 'approval'; changeSetIds: string[]; commandIds: string[] }
  | { kind: 'finished'; status: string; turns: number; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } }
  | { kind: 'error'; message: string };

export interface AgentStreamMessage {
  type: 'agentStream';
  runId: string;
  steps: AgentStreamStep[];
}

/** Coalescing window. Long enough to batch a burst of tokens, short enough to feel live. */
const FLUSH_INTERVAL_MS = 50;

/**
 * Bridges agent EventBus events to the webview.
 *
 * Text arrives one token at a time. Posting each token individually would mean thousands
 * of postMessage calls per turn, which pins the extension host and makes the UI stutter —
 * so deltas are accumulated and flushed on a timer, with consecutive text merged into a
 * single step.
 */
export class AgentStreamBridge {
  private queue: AgentStreamStep[] = [];
  private runId: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(
    private readonly post: (message: AgentStreamMessage) => void,
    events: EventBus = EventBus.getInstance(),
  ) {
    this.unsubscribes.push(
      events.on('agent:runStarted', ({ runId }) => {
        this.runId = runId;
        this.queue = [];
      }),
      events.on('agent:turnStarted', ({ runId, turn, maxTurns }) =>
        this.enqueue(runId, { kind: 'turn', turn, maxTurns }),
      ),
      events.on('agent:textDelta', ({ runId, text }) => this.enqueue(runId, { kind: 'text', text })),
      events.on('agent:thinkingDelta', ({ runId, text }) =>
        this.enqueue(runId, { kind: 'thinking', text }),
      ),
      events.on('agent:toolCallStarted', ({ runId, toolCallId, name }) =>
        this.enqueue(runId, { kind: 'tool', toolCallId, name, status: 'running' }),
      ),
      events.on('agent:toolCallResult', ({ runId, toolCallId, name, ok, preview }) =>
        this.enqueue(runId, {
          kind: 'tool',
          toolCallId,
          name,
          status: ok ? 'ok' : 'error',
          preview,
        }),
      ),
      events.on('agent:approvalRequired', ({ runId, changeSetIds, commandIds }) =>
        this.enqueue(runId, { kind: 'approval', changeSetIds, commandIds }),
      ),
      events.on('agent:runFinished', ({ runId, status, turns, usage }) => {
        this.enqueue(runId, { kind: 'finished', status, turns, usage });
        this.flush();
      }),
      events.on('agent:error', ({ runId, message }) => {
        this.enqueue(runId, { kind: 'error', message });
        this.flush();
      }),
    );
  }

  private enqueue(runId: string, step: AgentStreamStep): void {
    this.runId = runId;

    // Merge consecutive text and thinking so a turn's worth of tokens becomes one step
    // rather than several hundred.
    const last = this.queue.at(-1);
    if (
      last &&
      (step.kind === 'text' || step.kind === 'thinking') &&
      last.kind === step.kind
    ) {
      last.text += step.text;
    } else {
      this.queue.push(step);
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.queue.length || !this.runId) return;

    const steps = this.queue;
    this.queue = [];
    this.post({ type: 'agentStream', runId: this.runId, steps });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribes.forEach((unsubscribe) => unsubscribe());
    this.unsubscribes.length = 0;
  }
}
