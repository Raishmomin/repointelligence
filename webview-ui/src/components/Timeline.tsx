import { useEffect, useRef } from 'react';
import type { AgentStreamStep, ChatMessageDto, PendingApprovalDto } from '@shared/webview.types';
import type { TimelineEntry } from '../state/appReducer';

interface Props {
  messages: ChatMessageDto[];
  streaming: string;
  timeline: TimelineEntry[];
  approvals: PendingApprovalDto[];
  onApproveChangeSet(id: string): void;
  onRejectChangeSet(id: string): void;
  onApproveCommand(id: string): void;
  onRejectCommand(id: string): void;
  onOpenDiff(changeSetId: string, path: string): void;
}

/** Chat history, the live agent timeline, and any approvals waiting on the user. */
export function Timeline({
  messages,
  streaming,
  timeline,
  approvals,
  onApproveChangeSet,
  onRejectChangeSet,
  onApproveCommand,
  onRejectCommand,
  onOpenDiff,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the tail as content arrives. `auto` rather than `smooth`: during streaming a
  // smooth scroll never finishes before the next update restarts it.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages.length, streaming, timeline, approvals.length]);

  return (
    <div className="timeline">
      {messages.map((message) => (
        <div key={message.id} className={`bubble bubble-${message.role}`}>
          <span className="bubble-role">{message.role === 'user' ? 'You' : 'Assistant'}</span>
          <div className="bubble-content">{message.content}</div>
        </div>
      ))}

      {streaming && (
        <div className="bubble bubble-assistant">
          <span className="bubble-role">Assistant</span>
          <div className="bubble-content">{streaming}</div>
        </div>
      )}

      {timeline.map((entry, index) => (
        <RunPanel key={`${entry.runId}-${index}`} entry={entry} />
      ))}

      {approvals.length > 0 && (
        <div className="approvals">
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.changeSetId ?? approval.commandId}
              approval={approval}
              onApprove={() =>
                approval.changeSetId
                  ? onApproveChangeSet(approval.changeSetId)
                  : onApproveCommand(approval.commandId!)
              }
              onReject={() =>
                approval.changeSetId
                  ? onRejectChangeSet(approval.changeSetId)
                  : onRejectCommand(approval.commandId!)
              }
              onOpenDiff={(path) => approval.changeSetId && onOpenDiff(approval.changeSetId, path)}
            />
          ))}
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}

/**
 * Renders the token tail of a run footer, or nothing when there is nothing to report.
 *
 * Ollama reported no counts at all until recently, and an OpenAI-compatible endpoint
 * still reports none if it rejects `stream_options` — so zero has to mean "unknown"
 * rather than "free".
 */
function usageLabel(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }): string {
  if (!usage.inputTokens && !usage.outputTokens) return '';

  const cached = usage.cacheReadTokens ? `, ${usage.cacheReadTokens} cached` : '';
  return ` \u00b7 ${usage.inputTokens} in, ${usage.outputTokens} out${cached}`;
}

function RunPanel({ entry }: { entry: TimelineEntry }) {
  const turn = [...entry.steps].reverse().find((step) => step.kind === 'turn');
  const finished = entry.steps.find((step) => step.kind === 'finished');

  // While the run is live, its streamed text is the only place the reply exists, so it
  // shows here. Once the run finishes, the final reply is recorded as a chat bubble —
  // repeating it in the panel is the duplication that made the timeline unreadable. A
  // finished panel keeps only the process: tools, thinking, errors.
  const steps = finished ? entry.steps.filter((step) => step.kind !== 'text') : entry.steps;
  const processOnly = finished && steps.every((step) => step.kind === 'turn' || step.kind === 'finished');

  // A finished run that never used a tool has no process worth a panel of its own; the
  // bubble already says everything it could.
  if (processOnly && finished.kind === 'finished' && finished.status === 'completed') {
    return (
      <div className="run run-quiet">
        <div className="run-footer">
          {finished.status} after {finished.turns} turn{finished.turns === 1 ? '' : 's'}
          {usageLabel(finished.usage)}
        </div>
      </div>
    );
  }

  return (
    <div className="run">
      <div className="run-header">
        <span className="run-title">Agent</span>
        {turn?.kind === 'turn' && (
          <span className="run-turn">
            turn {turn.turn}/{turn.maxTurns}
          </span>
        )}
      </div>
      <div className="run-body">
        {steps.map((step, index) => (
          <Step key={index} step={step} />
        ))}
      </div>
      {finished?.kind === 'finished' && (
        <div className="run-footer">
          {finished.status} after {finished.turns} turn{finished.turns === 1 ? '' : 's'}
          {/* Zero means the backend reported nothing, not that the run was free. Printing
              "0 in, 0 out" invites the reader to believe a number that was never measured. */}
          {usageLabel(finished.usage)}
        </div>
      )}
    </div>
  );
}

function Step({ step }: { step: AgentStreamStep }) {
  switch (step.kind) {
    case 'turn':
    case 'finished':
      // Rendered in the run header and footer respectively.
      return null;
    case 'text':
      return <div className="step step-text">{step.text}</div>;
    case 'thinking':
      return (
        <details className="step step-thinking">
          <summary>Thinking</summary>
          <div>{step.text}</div>
        </details>
      );
    case 'tool': {
      const icon = step.status === 'running' ? '○' : step.status === 'ok' ? '✓' : '✗';
      const summary = (
        <>
          <span className="step-tool-icon">{icon}</span>
          <span className="step-tool-name">{step.name}</span>
          {step.args && <span className="step-tool-args">{step.args}</span>}
        </>
      );

      // Only worth expanding when there is something underneath. A call still running, or
      // one whose result was empty, stays a plain row so it cannot be clicked to nothing —
      // and falls back to the one-line preview, which is all there is to show.
      if (!step.output) {
        return (
          <div className={`step step-tool step-tool-${step.status}`}>
            {summary}
            {step.preview && <span className="step-tool-preview">{step.preview}</span>}
          </div>
        );
      }

      return (
        <details className={`step step-tool step-tool-${step.status}`}>
          <summary>{summary}</summary>
          <pre className="step-tool-output">{step.output}</pre>
        </details>
      );
    }
    case 'approval': {
      const count = step.changeSetIds.length + step.commandIds.length;
      return (
        <div className="step step-approval">
          Waiting for your approval on {count} action{count === 1 ? '' : 's'}
        </div>
      );
    }
    case 'error':
      return <div className="step step-error">⚠ {step.message}</div>;
    default:
      // Deliberately lenient: a step kind added by a newer host must not blank the panel.
      return null;
  }
}

function ApprovalCard({
  approval,
  onApprove,
  onReject,
  onOpenDiff,
}: {
  approval: PendingApprovalDto;
  onApprove(): void;
  onReject(): void;
  onOpenDiff(path: string): void;
}) {
  return (
    <div className={`approval approval-${approval.risk}`}>
      <div className="approval-summary">{approval.summary}</div>

      {approval.paths.length > 0 && (
        <div className="approval-paths">
          {approval.paths.map((path) => (
            <button key={path} type="button" className="approval-path" onClick={() => onOpenDiff(path)}>
              {path}
            </button>
          ))}
        </div>
      )}

      <div className="approval-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={onApprove}>
          Approve
        </button>
        <button type="button" className="btn btn-small" onClick={onReject}>
          Reject
        </button>
      </div>
    </div>
  );
}
