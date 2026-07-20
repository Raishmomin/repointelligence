import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/shared/EventBus';
import {
  AgentStreamBridge,
  AgentStreamMessage,
} from '../../src/vscode/providers/AgentStreamBridge';

describe('AgentStreamBridge', () => {
  let events: EventBus;
  let posted: AgentStreamMessage[];
  let bridge: AgentStreamBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    events = new EventBus();
    posted = [];
    bridge = new AgentStreamBridge((message) => posted.push(message), events);
    events.emit('agent:runStarted', { runId: 'run-1', prompt: 'do a thing', mode: 'implement' });
  });

  const flush = () => vi.advanceTimersByTime(60);

  describe('batching', () => {
    it('does not post one message per token', () => {
      // One postMessage per token pins the extension host and makes the UI stutter.
      for (let index = 0; index < 500; index++) {
        events.emit('agent:textDelta', { runId: 'run-1', text: 'x' });
      }
      expect(posted).toHaveLength(0);

      flush();
      expect(posted).toHaveLength(1);
    });

    it('merges consecutive text deltas into one step', () => {
      events.emit('agent:textDelta', { runId: 'run-1', text: 'Hello' });
      events.emit('agent:textDelta', { runId: 'run-1', text: ', ' });
      events.emit('agent:textDelta', { runId: 'run-1', text: 'world' });
      flush();

      expect(posted[0].steps).toEqual([{ kind: 'text', text: 'Hello, world' }]);
    });

    it('keeps thinking separate from text', () => {
      events.emit('agent:thinkingDelta', { runId: 'run-1', text: 'considering' });
      events.emit('agent:textDelta', { runId: 'run-1', text: 'answering' });
      flush();

      expect(posted[0].steps).toEqual([
        { kind: 'thinking', text: 'considering' },
        { kind: 'text', text: 'answering' },
      ]);
    });

    it('does not merge text across an intervening tool call', () => {
      events.emit('agent:textDelta', { runId: 'run-1', text: 'before' });
      events.emit('agent:toolCallStarted', { runId: 'run-1', toolCallId: 't1', name: 'read_file' });
      events.emit('agent:textDelta', { runId: 'run-1', text: 'after' });
      flush();

      expect(posted[0].steps.map((step) => step.kind)).toEqual(['text', 'tool', 'text']);
    });

    it('posts nothing when there is nothing queued', () => {
      flush();
      expect(posted).toHaveLength(0);
    });
  });

  describe('step shapes', () => {
    it('reports turn progress', () => {
      events.emit('agent:turnStarted', { runId: 'run-1', turn: 3, maxTurns: 30 });
      flush();
      expect(posted[0].steps[0]).toEqual({ kind: 'turn', turn: 3, maxTurns: 30 });
    });

    it('marks a tool as running, then as its outcome', () => {
      events.emit('agent:toolCallStarted', { runId: 'run-1', toolCallId: 't1', name: 'read_file' });
      flush();
      expect(posted[0].steps[0]).toMatchObject({ status: 'running', name: 'read_file' });

      events.emit('agent:toolCallResult', {
        runId: 'run-1',
        toolCallId: 't1',
        name: 'read_file',
        ok: true,
        preview: '1\texport const a = 1;',
      });
      flush();
      expect(posted[1].steps[0]).toMatchObject({ status: 'ok', preview: '1\texport const a = 1;' });
    });

    it('marks a failed tool as error', () => {
      events.emit('agent:toolCallResult', {
        runId: 'run-1',
        toolCallId: 't1',
        name: 'str_replace',
        ok: false,
        preview: 'old_string matches 3 places',
      });
      flush();
      expect(posted[0].steps[0]).toMatchObject({ status: 'error' });
    });

    it('surfaces pending approvals', () => {
      events.emit('agent:approvalRequired', {
        runId: 'run-1',
        changeSetIds: ['cs-1', 'cs-2'],
        commandIds: [],
      });
      flush();
      expect(posted[0].steps[0]).toEqual({
        kind: 'approval',
        changeSetIds: ['cs-1', 'cs-2'],
        commandIds: [],
      });
    });
  });

  describe('terminal events flush immediately', () => {
    it('posts on run completion without waiting for the timer', () => {
      // Waiting up to 50ms to say "done" would leave a spinner running after the fact.
      events.emit('agent:runFinished', {
        runId: 'run-1',
        status: 'completed',
        turns: 4,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
      });
      expect(posted).toHaveLength(1);
      expect(posted[0].steps.at(-1)).toMatchObject({ kind: 'finished', status: 'completed' });
    });

    it('posts on error without waiting', () => {
      events.emit('agent:error', { runId: 'run-1', message: 'rate limited' });
      expect(posted).toHaveLength(1);
      expect(posted[0].steps[0]).toEqual({ kind: 'error', message: 'rate limited' });
    });

    it('includes preceding buffered text in the terminal flush', () => {
      events.emit('agent:textDelta', { runId: 'run-1', text: 'partial answer' });
      events.emit('agent:runFinished', {
        runId: 'run-1',
        status: 'completed',
        turns: 1,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      });

      expect(posted).toHaveLength(1);
      expect(posted[0].steps.map((step) => step.kind)).toEqual(['text', 'finished']);
    });
  });

  describe('lifecycle', () => {
    it('tags every message with the run id', () => {
      events.emit('agent:textDelta', { runId: 'run-1', text: 'x' });
      flush();
      expect(posted[0].runId).toBe('run-1');
    });

    it('clears buffered steps when a new run starts', () => {
      events.emit('agent:textDelta', { runId: 'run-1', text: 'stale' });
      events.emit('agent:runStarted', { runId: 'run-2', prompt: 'next', mode: 'plan' });
      events.emit('agent:textDelta', { runId: 'run-2', text: 'fresh' });
      flush();

      expect(posted[0].runId).toBe('run-2');
      expect(posted[0].steps).toEqual([{ kind: 'text', text: 'fresh' }]);
    });

    it('stops posting after dispose', () => {
      bridge.dispose();
      events.emit('agent:textDelta', { runId: 'run-1', text: 'ignored' });
      flush();
      expect(posted).toHaveLength(0);
    });
  });
});
