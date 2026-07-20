import {
  assertNever,
  type AgentStreamStep,
  type ChatMessageDto,
  type ExtensionToWebview,
  type ModelOptionDto,
  type ModelStateDto,
  type PendingApprovalDto,
  type SessionDto,
  type TaskModeDto,
} from '@shared/webview.types';

export interface TimelineEntry {
  runId: string;
  steps: AgentStreamStep[];
}

export interface AppState {
  status: string;
  statusMessage?: string;
  projectName?: string;
  framework?: string;
  sessions: SessionDto[];
  activeSessionId: string | null;
  messages: ChatMessageDto[];
  /** Assistant text still streaming in, before it lands as a message. */
  streaming: string;
  contextSummary?: string;
  timeline: TimelineEntry[];
  models: ModelOptionDto[];
  modelState: ModelStateDto;
  approvals: PendingApprovalDto[];
  error?: string;
}

export const initialState: AppState = {
  status: 'idle',
  sessions: [],
  activeSessionId: null,
  messages: [],
  streaming: '',
  timeline: [],
  models: [],
  modelState: {
    activeProviderId: '',
    activeProviderLabel: 'Loading…',
    mode: 'implement',
  },
  approvals: [],
};

export type AppAction =
  | { type: 'host'; message: ExtensionToWebview }
  | { type: 'setMode'; mode: TaskModeDto }
  | { type: 'dismissError' };

export function appReducer(state: AppState, action: AppAction): AppState {
  if (action.type === 'setMode') {
    // Applied optimistically so the toggle feels instant; the host confirms with a
    // modelState message.
    return { ...state, modelState: { ...state.modelState, mode: action.mode } };
  }
  if (action.type === 'dismissError') return { ...state, error: undefined };

  return reduceHostMessage(state, action.message);
}

function reduceHostMessage(state: AppState, message: ExtensionToWebview): AppState {
  switch (message.type) {
    case 'status':
      return { ...state, status: message.status, statusMessage: message.message };

    case 'projectInfo':
      return { ...state, projectName: message.name, framework: message.framework };

    case 'sessions':
      return { ...state, sessions: message.sessions, activeSessionId: message.activeSessionId };

    case 'messages':
      // A fresh message list means the stream that produced it has landed.
      return { ...state, messages: message.messages, streaming: '' };

    case 'streamChunk':
      return { ...state, streaming: state.streaming + message.chunk };

    case 'contextInfo':
      return { ...state, contextSummary: message.summary };

    case 'agentTimeline':
      return {
        ...state,
        timeline: [...state.timeline, { runId: 'log', steps: [{ kind: 'text', text: message.content }] }],
      };

    case 'agentStream':
      return { ...state, timeline: appendSteps(state.timeline, message.runId, message.steps) };

    case 'modelState':
      return { ...state, modelState: message.state, models: message.models };

    case 'providers':
      // Provider schemas are fetched on demand by the settings panel rather than held in
      // app state, so a push is only a hint that the catalogue changed.
      return state;

    case 'approvals':
      return { ...state, approvals: message.approvals };

    case 'error':
      return { ...state, error: message.message, status: 'idle' };

    case 'rpcResponse':
      // Handled by the rpc module before the reducer sees it.
      return state;

    default:
      return assertNever(message, 'host message');
  }
}

/**
 * Appends steps to the run they belong to, merging consecutive text so a turn's worth of
 * batches renders as one paragraph rather than dozens.
 */
function appendSteps(
  timeline: TimelineEntry[],
  runId: string,
  steps: AgentStreamStep[],
): TimelineEntry[] {
  const index = timeline.findIndex((entry) => entry.runId === runId);
  if (index === -1) return [...timeline, { runId, steps }];

  const existing = timeline[index];
  const merged = [...existing.steps];

  for (const step of steps) {
    const last = merged[merged.length - 1];
    if (last && (step.kind === 'text' || step.kind === 'thinking') && last.kind === step.kind) {
      merged[merged.length - 1] = { ...last, text: last.text + step.text };
    } else if (step.kind === 'tool') {
      // A tool row is updated in place as it moves from running to its outcome.
      const toolIndex = merged.findIndex(
        (candidate) => candidate.kind === 'tool' && candidate.toolCallId === step.toolCallId,
      );
      if (toolIndex === -1) merged.push(step);
      else merged[toolIndex] = step;
    } else {
      merged.push(step);
    }
  }

  const next = [...timeline];
  next[index] = { runId, steps: merged };
  return next;
}
