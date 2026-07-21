import { EventBus } from '../../shared/EventBus';
import type { AgentStreamStep } from '../../shared/types/webview.types';

// Re-exported for existing importers; the type itself now lives in the shared protocol so
// the webview can consume it without reaching into the extension host's module graph.
export type { AgentStreamStep };

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
      events.on('agent:toolCallStarted', ({ runId, toolCallId, name, args }) =>
        this.enqueue(runId, { kind: 'tool', toolCallId, name, status: 'running', args }),
      ),
      events.on('agent:toolCallResult', ({ runId, toolCallId, name, ok, preview, output }) =>
        this.enqueue(runId, {
          kind: 'tool',
          toolCallId,
          name,
          status: ok ? 'ok' : 'error',
          preview,
          output,
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
