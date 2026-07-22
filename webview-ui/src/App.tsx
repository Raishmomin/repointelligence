import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ExtensionToWebview, TaskModeDto } from '@shared/webview.types';
import { ComposerBar } from './components/ComposerBar';
import { ProviderPanel } from './components/ProviderPanel';
import { SessionPanel } from './components/SessionPanel';
import { Timeline } from './components/Timeline';
import { post, rejectAllPending, resolveRpc } from './messaging/rpc';
import { appReducer, initialState } from './state/appReducer';

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [showProviders, setShowProviders] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // A reload strands the previous page's in-flight requests; their promises would
    // otherwise never settle.
    rejectAllPending('Panel reloaded.');

    const onMessage = (event: MessageEvent<ExtensionToWebview>) => {
      const message = event.data;
      if (resolveRpc(message)) return;

      try {
        dispatch({ type: 'host', message });
      } catch (error) {
        // A bundle cached from an earlier version can receive a message its reducer does
        // not know. Skipping one message beats taking down the panel.
        console.warn('Unhandled host message', message, error);
      }
    };

    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    post({ type: 'sendAgentMessage', text, mode: state.modelState.mode });
  }, [input, state.modelState.mode]);

  const setMode = useCallback((mode: TaskModeDto) => {
    dispatch({ type: 'setMode', mode });
    post({ type: 'setMode', mode });
  }, []);

  const busy = state.status !== 'idle' && state.status !== 'no-project';

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">{state.projectName ?? 'Repo Intelligence'}</span>
        {state.framework && <span className="app-framework">{state.framework}</span>}
        <button
          type="button"
          className="btn btn-small app-chats"
          title="Chats"
          onClick={() => setShowSessions(true)}
        >
          ☰
        </button>
        {busy && (
          <button type="button" className="btn btn-small" onClick={() => post({ type: 'cancelRun' })}>
            Stop
          </button>
        )}
      </header>

      {state.error && (
        <div className="banner banner-error" onClick={() => dispatch({ type: 'dismissError' })}>
          ⚠ {state.error}
        </div>
      )}

      {showSessions ? (
        <SessionPanel
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          onClose={() => setShowSessions(false)}
          onNew={() => post({ type: 'newSession' })}
          onSelect={(sessionId) => post({ type: 'selectSession', sessionId })}
          onDelete={(sessionId) => post({ type: 'deleteSession', sessionId })}
        />
      ) : showProviders ? (
        <ProviderPanel
          onClose={() => setShowProviders(false)}
          onSaved={() => post({ type: 'refreshModels' })}
        />
      ) : (
        <>
          <Timeline
            messages={state.messages}
            streaming={state.streaming}
            timeline={state.timeline}
            approvals={state.approvals}
            onApproveChangeSet={(id) => post({ type: 'approveChangeSet', changeSetId: id })}
            onRejectChangeSet={(id) => post({ type: 'rejectChangeSet', changeSetId: id })}
            onApproveCommand={(id) => post({ type: 'approveCommand', commandId: id })}
            onRejectCommand={(id) => post({ type: 'rejectCommand', commandId: id })}
            onOpenDiff={(changeSetId, path) => post({ type: 'openDiff', changeSetId, path })}
          />

          {state.statusMessage && <div className="status-line">{state.statusMessage}</div>}

          <div className="composer">
            <ComposerBar
              state={state.modelState}
              models={state.models}
              onSelectModel={(providerId, modelId) => post({ type: 'selectModel', providerId, modelId })}
              onSetMode={setMode}
              onAddProvider={() => setShowProviders(true)}
              onRefreshModels={() => post({ type: 'refreshModels' })}
            />

            <div className="composer-input">
              <textarea
                ref={inputRef}
                value={input}
                placeholder="Ask about your codebase, or describe a change…"
                rows={3}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends; Shift+Enter is a newline, matching every chat UI.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              {/* Offered only between runs, and only once there is an exchange to redo.
                  Retry discards the last reply and re-runs its prompt — each run starts
                  from the prompt alone, so this is a fresh attempt, not a continuation. */}
              {!busy && !input && state.messages.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  title="Discard the last reply and run its prompt again"
                  onClick={() => post({ type: 'retryMessage' })}
                >
                  ↻ Retry
                </button>
              )}
              <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>
                {busy ? '…' : 'Send'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
