import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ApprovalModeDto, ExtensionToWebview, TaskModeDto } from '@shared/webview.types';
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
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    post({ type: 'sendAgentMessage', text, mode: state.modelState.mode });
  }, [input, state.modelState.mode]);

  const setMode = useCallback((mode: TaskModeDto) => {
    dispatch({ type: 'setMode', mode });
    post({ type: 'setMode', mode });
  }, []);

  const setApprovalMode = useCallback((mode: ApprovalModeDto) => {
    dispatch({ type: 'setApprovalMode', mode });
    post({ type: 'setApprovalMode', mode });
  }, []);

  const handleApproveChangeSet = useCallback((id: string) => {
    dispatch({ type: 'optimisticApproval', id });
    post({ type: 'approveChangeSet', changeSetId: id });
  }, []);

  const handleRejectChangeSet = useCallback((id: string) => {
    dispatch({ type: 'optimisticApproval', id });
    post({ type: 'rejectChangeSet', changeSetId: id });
  }, []);

  const handleApproveCommand = useCallback((id: string) => {
    dispatch({ type: 'optimisticApproval', id });
    post({ type: 'approveCommand', commandId: id });
  }, []);

  const handleRejectCommand = useCallback((id: string) => {
    dispatch({ type: 'optimisticApproval', id });
    post({ type: 'rejectCommand', commandId: id });
  }, []);

  const filteredApprovals = useMemo(() => {
    return state.approvals.filter(
      (a) =>
        !state.optimisticApprovals.has(a.changeSetId ?? '') &&
        !state.optimisticApprovals.has(a.commandId ?? ''),
    );
  }, [state.approvals, state.optimisticApprovals]);

  const busy = state.status !== 'idle' && state.status !== 'no-project';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <span className="app-title">{state.projectName ?? 'Repo Intelligence'}</span>
          {state.framework && <span className="app-framework">{state.framework}</span>}
        </div>
        <div className="app-header-right">
          <button
            type="button"
            className="btn btn-small app-chats"
            title="Chats"
            onClick={() => setShowSessions(true)}
          >
            ☰
          </button>
          {busy && (
            <button type="button" className="btn btn-small btn-stop" onClick={() => post({ type: 'cancelRun' })}>
              Stop
            </button>
          )}
        </div>
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
            approvals={filteredApprovals}
            status={state.status}
            onApproveChangeSet={handleApproveChangeSet}
            onRejectChangeSet={handleRejectChangeSet}
            onApproveCommand={handleApproveCommand}
            onRejectCommand={handleRejectCommand}
            onOpenDiff={(changeSetId, path) => post({ type: 'openDiff', changeSetId, path })}
            onRetry={() => post({ type: 'retryMessage' })}
          />

          {state.statusMessage && <div className="status-line">{state.statusMessage}</div>}

          <div className="composer">
            <ComposerBar
              state={state.modelState}
              models={state.models}
              onSelectModel={(providerId, modelId) => post({ type: 'selectModel', providerId, modelId })}
              onSetMode={setMode}
              onSetApprovalMode={setApprovalMode}
              onAddProvider={() => setShowProviders(true)}
              onRefreshModels={() => post({ type: 'refreshModels' })}
            />

            <div className="composer-input-pill">
              <textarea
                ref={inputRef}
                value={input}
                placeholder="Ask or prompt..."
                rows={1}
                onChange={(event) => {
                  setInput(event.target.value);
                  // Auto expand text area up to max height
                  event.target.style.height = 'auto';
                  event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <button
                type="button"
                className={`send-circle-btn ${busy || !input.trim() ? 'disabled' : 'active'}`}
                disabled={busy || !input.trim()}
                onClick={send}
                title="Send message"
              >
                ↑
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
