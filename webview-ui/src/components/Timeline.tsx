import { useEffect, useMemo, useRef } from 'react';
import type { AgentStreamStep, ChatMessageDto, PendingApprovalDto } from '@shared/webview.types';
import type { TimelineEntry } from '../state/appReducer';
import { MarkdownContent } from './MarkdownContent';

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

// ── Interleaving ─────────────────────────────────────────────

/**
 * An entry in the unified, chronologically ordered feed.
 *
 * The extension host records messages like this:
 *   1. User message (recorded before the run starts)
 *   2. Agent run streams in (timeline entry)
 *   3. Assistant message (recorded after the run finishes)
 *
 * So every user message is followed by at most one run panel and then the assistant reply.
 * We pair them by position: user messages at index 0, 2, 4… and assistant replies at
 * 1, 3, 5… Each user message is the "turn owner" for the timeline entry that streamed in
 * between it and its assistant reply.
 */
type FeedItem =
  | { kind: 'user'; message: ChatMessageDto }
  | { kind: 'run'; entry: TimelineEntry }
  | { kind: 'assistant'; message: ChatMessageDto }
  | { kind: 'streaming'; text: string };

function buildFeed(
  messages: ChatMessageDto[],
  timeline: TimelineEntry[],
  streaming: string,
): FeedItem[] {
  const feed: FeedItem[] = [];

  // Timeline entries that have not yet been placed into the feed.
  // We consume them in order as we walk the message list.
  let nextRun = 0;

  // Walk messages in order. The agent flow produces strict pairs:
  // user → (agent run) → assistant, user → (agent run) → assistant, …
  // Legacy non-agent chat (handleSendMessage) does user → assistant with no run.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'user') {
      feed.push({ kind: 'user', message: msg });

      // After a user message, check if there is a run entry that belongs to this turn.
      // A run belongs to this turn if the next message is an assistant reply (the run
      // happened between them) or if this is the last message (the run is still live).
      const nextMsg = messages[i + 1];
      const isLastMessage = i === messages.length - 1;

      if (nextRun < timeline.length && (isLastMessage || nextMsg?.role === 'assistant')) {
        // Skip timeline entries with runId 'log' — those are showAgentLog calls
        // (command output, legacy timeline) that are not tied to a conversation turn.
        while (nextRun < timeline.length && timeline[nextRun].runId === 'log') {
          feed.push({ kind: 'run', entry: timeline[nextRun] });
          nextRun++;
        }
        if (nextRun < timeline.length) {
          feed.push({ kind: 'run', entry: timeline[nextRun] });
          nextRun++;
        }
      }
    } else {
      // Assistant message
      feed.push({ kind: 'assistant', message: msg });
    }
  }

  // Any remaining timeline entries that were not matched to a message pair
  // (e.g. a run started but no assistant reply yet, or log entries after the last message).
  while (nextRun < timeline.length) {
    feed.push({ kind: 'run', entry: timeline[nextRun] });
    nextRun++;
  }

  // Live streaming text (before the assistant message is committed).
  if (streaming) {
    feed.push({ kind: 'streaming', text: streaming });
  }

  return feed;
}

// ── Component ────────────────────────────────────────────────

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

  const feed = useMemo(
    () => buildFeed(messages, timeline, streaming),
    [messages, timeline, streaming],
  );

  return (
    <div className="timeline">
      {feed.map((item, index) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.message.id} className="bubble bubble-user">
                <span className="bubble-role">You</span>
                <div className="bubble-content">{item.message.content}</div>
              </div>
            );
          case 'assistant':
            return (
              <div key={item.message.id} className="bubble bubble-assistant">
                <span className="bubble-role">Assistant</span>
                <MarkdownContent className="bubble-content" content={item.message.content} />
              </div>
            );
          case 'run':
            return <RunPanel key={`run-${item.entry.runId}-${index}`} entry={item.entry} />;
          case 'streaming':
            return (
              <div key="streaming" className="bubble bubble-assistant">
                <span className="bubble-role">Assistant</span>
                <MarkdownContent className="bubble-content" content={item.text} />
              </div>
            );
        }
      })}

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

// ── Run panel ────────────────────────────────────────────────

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

  // A successfully finished run folds its process behind one line, the way an assistant
  // that shows its work on request reads better than one that always shows it. A live run
  // stays open — the streamed text exists nowhere else yet — and a failed or cancelled
  // run stays open too, because a hidden failure looks like a hang.
  if (finished?.kind === 'finished' && finished.status === 'completed') {
    const toolCount = steps.filter((step) => step.kind === 'tool').length;
    return (
      <details className="run run-collapsed">
        <summary className="run-summary">
          {/* Zero usage means the backend reported nothing, not that the run was free —
              usageLabel renders nothing in that case rather than "0 in, 0 out". */}
          Worked for {finished.turns} turn{finished.turns === 1 ? '' : 's'}
          {toolCount > 0 && ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}`}
          {usageLabel(finished.usage)}
        </summary>
        <div className="run-body">
          {steps.map((step, index) => (
            <Step key={index} step={step} />
          ))}
        </div>
      </details>
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
