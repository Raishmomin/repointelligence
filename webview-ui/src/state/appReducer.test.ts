import { describe, expect, it } from 'vitest';
import type { AgentStreamStep, ExtensionToWebview } from '@shared/webview.types';
import { appReducer, initialState, type AppState } from './appReducer';

function host(message: ExtensionToWebview, from: AppState = initialState): AppState {
  return appReducer(from, { type: 'host', message });
}

function stream(runId: string, steps: AgentStreamStep[], from: AppState = initialState): AppState {
  return host({ type: 'agentStream', runId, steps }, from);
}

describe('appReducer', () => {
  describe('agent stream merging', () => {
    it('starts a run entry on the first batch', () => {
      const state = stream('r1', [{ kind: 'text', text: 'Hello' }]);
      expect(state.timeline).toHaveLength(1);
      expect(state.timeline[0].runId).toBe('r1');
    });

    it('merges consecutive text across batches into one paragraph', () => {
      // Batches arrive every ~50ms; without merging a turn renders as dozens of fragments.
      let state = stream('r1', [{ kind: 'text', text: 'Hello' }]);
      state = stream('r1', [{ kind: 'text', text: ', world' }], state);

      expect(state.timeline[0].steps).toEqual([{ kind: 'text', text: 'Hello, world' }]);
    });

    it('does not merge text across an intervening tool call', () => {
      let state = stream('r1', [{ kind: 'text', text: 'before' }]);
      state = stream('r1', [{ kind: 'tool', toolCallId: 't1', name: 'glob', status: 'running' }], state);
      state = stream('r1', [{ kind: 'text', text: 'after' }], state);

      expect(state.timeline[0].steps.map((s) => s.kind)).toEqual(['text', 'tool', 'text']);
    });

    it('keeps thinking separate from text', () => {
      const state = stream('r1', [
        { kind: 'thinking', text: 'considering' },
        { kind: 'text', text: 'answering' },
      ]);
      expect(state.timeline[0].steps.map((s) => s.kind)).toEqual(['thinking', 'text']);
    });

    it('updates a tool row in place rather than appending a duplicate', () => {
      // The row flips from running to its outcome; appending would show it twice.
      let state = stream('r1', [{ kind: 'tool', toolCallId: 't1', name: 'read_file', status: 'running' }]);
      state = stream(
        'r1',
        [{ kind: 'tool', toolCallId: 't1', name: 'read_file', status: 'ok', preview: '1 line' }],
        state,
      );

      expect(state.timeline[0].steps).toHaveLength(1);
      expect(state.timeline[0].steps[0]).toMatchObject({ status: 'ok', preview: '1 line' });
    });

    it('keeps distinct tool calls apart', () => {
      const state = stream('r1', [
        { kind: 'tool', toolCallId: 't1', name: 'glob', status: 'running' },
        { kind: 'tool', toolCallId: 't2', name: 'grep', status: 'running' },
      ]);
      expect(state.timeline[0].steps).toHaveLength(2);
    });

    it('separates concurrent runs', () => {
      let state = stream('r1', [{ kind: 'text', text: 'first run' }]);
      state = stream('r2', [{ kind: 'text', text: 'second run' }], state);

      expect(state.timeline.map((entry) => entry.runId)).toEqual(['r1', 'r2']);
    });
  });

  describe('chat', () => {
    it('accumulates streamed chunks', () => {
      let state = host({ type: 'streamChunk', chunk: 'Hel' });
      state = host({ type: 'streamChunk', chunk: 'lo' }, state);
      expect(state.streaming).toBe('Hello');
    });

    it('clears the buffer once the messages land', () => {
      // Otherwise the answer renders twice — once streaming, once as a message.
      let state = host({ type: 'streamChunk', chunk: 'partial' });
      state = host({ type: 'messages', messages: [] }, state);
      expect(state.streaming).toBe('');
    });
  });

  describe('tool rows', () => {
    it('keeps the arguments when the result arrives without them', () => {
      // args are known when a call starts, output only when it ends. Replacing the row
      // instead of merging would drop whichever half arrived first.
      let state = stream('r1', [
        { kind: 'tool', toolCallId: 't1', name: 'glob', status: 'running', args: 'pattern: **/*footer*' },
      ]);
      state = stream(
        'r1',
        [{ kind: 'tool', toolCallId: 't1', name: 'glob', status: 'ok', output: 'Footer.tsx' }],
        state,
      );

      expect(state.timeline[0].steps).toHaveLength(1);
      expect(state.timeline[0].steps[0]).toMatchObject({
        status: 'ok',
        args: 'pattern: **/*footer*',
        output: 'Footer.tsx',
      });
    });

    it('shows one row when a call starts and finishes in the same batch', () => {
      // Both land in one 50ms flush for a fast tool, and the first batch for a run used to
      // be taken verbatim without deduping.
      const state = stream('r1', [
        { kind: 'tool', toolCallId: 't1', name: 'glob', status: 'running', args: 'pattern: x' },
        { kind: 'tool', toolCallId: 't1', name: 'glob', status: 'ok', output: 'none' },
      ]);

      expect(state.timeline[0].steps).toHaveLength(1);
      expect(state.timeline[0].steps[0]).toMatchObject({ status: 'ok', args: 'pattern: x' });
    });

    it('keeps separate calls to the same tool apart', () => {
      const state = stream('r1', [
        { kind: 'tool', toolCallId: 't1', name: 'read_file', status: 'ok', args: 'path: a.ts' },
        { kind: 'tool', toolCallId: 't2', name: 'read_file', status: 'ok', args: 'path: b.ts' },
      ]);

      expect(state.timeline[0].steps).toHaveLength(2);
    });
  });

  describe('sessions', () => {
    const CHATS = [
      { id: 's1', title: 'modify footer design', createdAt: 1, updatedAt: 20 },
      { id: 's2', title: 'New Chat Session', createdAt: 2, updatedAt: 10 },
    ];

    it('stores the list the host pushes', () => {
      const state = host({ type: 'sessions', sessions: CHATS, activeSessionId: 's1' });
      expect(state.sessions).toEqual(CHATS);
      expect(state.activeSessionId).toBe('s1');
    });

    it('follows the host when the active session changes', () => {
      // handleSelectSession re-posts the list precisely so this stays in step; the panel
      // marks the active row from this field alone.
      let state = host({ type: 'sessions', sessions: CHATS, activeSessionId: 's1' });
      state = host({ type: 'sessions', sessions: CHATS, activeSessionId: 's2' }, state);
      expect(state.activeSessionId).toBe('s2');
    });

    it('keeps the order the host sent rather than re-sorting', () => {
      // Ordering is by last activity, which only the host can know.
      const state = host({ type: 'sessions', sessions: CHATS, activeSessionId: null });
      expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    });

    it('handles having no sessions at all', () => {
      const state = host({ type: 'sessions', sessions: [], activeSessionId: null });
      expect(state.sessions).toEqual([]);
      expect(state.activeSessionId).toBeNull();
    });
  });

  describe('mode', () => {
    it('applies optimistically so the toggle feels instant', () => {
      const state = appReducer(initialState, { type: 'setMode', mode: 'plan' });
      expect(state.modelState.mode).toBe('plan');
    });

    it('is replaced by whatever the host confirms', () => {
      let state = appReducer(initialState, { type: 'setMode', mode: 'plan' });
      state = host(
        {
          type: 'modelState',
          state: { activeProviderId: 'a', activeProviderLabel: 'A', mode: 'explain' },
          models: [],
        },
        state,
      );
      expect(state.modelState.mode).toBe('explain');
    });
  });

  describe('errors', () => {
    it('surfaces an error and stops the busy state', () => {
      const state = host({ type: 'error', message: 'boom' }, { ...initialState, status: 'thinking' });
      expect(state.error).toBe('boom');
      expect(state.status).toBe('idle');
    });

    it('can be dismissed', () => {
      const withError = host({ type: 'error', message: 'boom' });
      expect(appReducer(withError, { type: 'dismissError' }).error).toBeUndefined();
    });
  });

  describe('unknown messages', () => {
    it('throws rather than corrupting state, for the caller to catch', () => {
      // App.tsx catches this: a bundle cached from an earlier version can receive a
      // message its reducer does not know, and skipping one beats blanking the panel.
      expect(() => host({ type: 'not-a-real-message' } as never)).toThrow(/Unhandled host message/);
    });
  });
});
