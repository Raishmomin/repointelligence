import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { EventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import {
  AgentRun,
  AgentRunStatus,
  AgentTask,
  ChangeSet,
  CommandRequest,
  TaskMode,
} from '../../shared/types/agent.types';
import {
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmToolResultBlock,
  LlmUsage,
} from '../providers/types';
import { gitServiceFor } from '../../layer1-intelligence/git/GitService';
import { FileStateTracker } from './FileStateTracker';
import { buildSystemPrompt } from './systemPrompt';
import { ToolRegistry } from './ToolRegistry';
import { ToolContext } from './tools/types';
import { TranscriptManager } from './TranscriptManager';

/**
 * Which tool calls from a parked turn are answered, and which are still waiting on the
 * user. Persisted, because approval can outlive the extension host.
 *
 * `toolUseIds` preserves the original order: every `tool_use` block in the parked
 * assistant turn must be answered, in one user message, in that order.
 */
interface PendingTurnState {
  toolUseIds: string[];
  resolved: Record<string, { content: string; isError?: boolean }>;
  awaiting: Record<string, { kind: 'file' | 'command'; subjectId: string; name: string }>;
}

interface RunState {
  run: AgentRun;
  transcript: TranscriptManager;
  fileState: FileStateTracker;
  pending?: PendingTurnState;
  turn: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  cancellation: vscode.CancellationTokenSource;
  /** How many times the agent has actually looked at the repository this run. */
  discoveryToolsUsed: number;
  /** Whether the search-first correction has already been spent. */
  nudgedToSearch: boolean;
}

/** Tools that count as having looked at the repository. */
const DISCOVERY_TOOLS = new Set(['read_file', 'glob', 'grep', 'query_index']);

/**
 * Whether a run that is about to end should instead be told to go and search.
 *
 * Triggers on "the agent never looked at the repository at all", which catches both the
 * reported failure (asking the user for a path) and answering from thin air. Bounded to
 * one correction per run so a model that genuinely has nothing to do still terminates.
 */
export function shouldNudgeToSearch(state: {
  discoveryToolsUsed: number;
  nudgedToSearch: boolean;
}): boolean {
  return state.discoveryToolsUsed === 0 && !state.nudgedToSearch;
}

export const SEARCH_FIRST_NUDGE =
  '[You ended your turn without looking at the repository at all. You have glob (find ' +
  'files by name), grep (search file contents) and query_index (search by concept). Use ' +
  'them to find what you need — do not ask the user for a path or filename, since ' +
  'searching is faster than asking. If you have already searched and genuinely cannot ' +
  'proceed, say exactly what you searched for and what came back.]';

/**
 * Runs the agent loop.
 *
 * Reads execute immediately. The first write or command proposal parks the run: its state
 * is persisted, the user is asked, and the loop resumes from exactly where it stopped once
 * every proposal from that turn has a decision.
 */
export class AgentService {
  private readonly registry = new ToolRegistry();
  private readonly active = new Map<string, RunState>();
  private readonly pendingChangeSets = new Map<string, ChangeSet>();
  private readonly pendingCommands = new Map<string, CommandRequest>();

  constructor(
    private readonly container: ServiceContainer,
    private readonly events: EventBus = EventBus.getInstance(),
    private readonly logger: Logger = Logger.getInstance(),
  ) {}

  // ── Entry point ────────────────────────────────────────────

  async run(
    prompt: string,
    mode: TaskMode,
    workspace: vscode.WorkspaceFolder,
    sessionId?: string,
  ): Promise<AgentRun> {
    const resolved = await this.container.providerFactory.resolveChatProvider();
    if (!resolved) {
      throw new Error(
        'No language model is available. Set an Anthropic API key, or start Ollama and ' +
          'set repo-intelligence.provider to "ollama".',
      );
    }
    if (resolved.notice) vscode.window.showWarningMessage(resolved.notice);

    const id = crypto.randomUUID();
    const now = Date.now();
    const task: AgentTask = { id, prompt, mode, workspaceUri: workspace.uri.toString(), sessionId };
    const run: AgentRun = { id, task, status: 'running', createdAt: now, updatedAt: now };

    this.container.database.run(
      'INSERT INTO agent_runs (id, workspace_uri, session_id, mode, prompt, status, created_at, updated_at, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, task.workspaceUri, sessionId ?? null, mode, prompt, run.status, now, now, 0],
    );

    const transcript = new TranscriptManager(resolved.provider.contextWindow);
    transcript.push({ role: 'user', content: await this.seedPrompt(prompt, resolved.provider, workspace) });

    const state: RunState = {
      run,
      transcript,
      fileState: new FileStateTracker(),
      turn: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      cancellation: new vscode.CancellationTokenSource(),
      discoveryToolsUsed: 0,
      nudgedToSearch: false,
    };
    this.active.set(id, state);

    this.events.emit('agent:runStarted', { runId: id, prompt, mode });
    return this.loop(state, resolved.provider, workspace, mode);
  }

  /**
   * Prepends relevant indexed code to the opening turn — but only for providers without
   * native tool calling.
   *
   * A model driving real tools does better with a clean prompt and the freedom to search
   * for what it decides it needs. A small local model on the JSON-envelope protocol often
   * will not issue that first search at all, and having relevant code already in front of
   * it is the difference between working and asking the user where the file is.
   */
  private async seedPrompt(
    prompt: string,
    provider: LlmProvider,
    workspace: vscode.WorkspaceFolder,
  ): Promise<string> {
    if (provider.supportsNativeTools) return prompt;

    try {
      const project = this.container.database.queryOne<{ id: string }>(
        'SELECT id FROM projects WHERE root_path = ?',
        [workspace.uri.fsPath],
      );
      if (!project) return prompt;

      const results = await this.container.hybridSearchEngine.search(project.id, prompt, 4);
      if (!results.length) return prompt;

      const budget = vscode.workspace
        .getConfiguration('repo-intelligence')
        .get<number>('agent.initialContextMaxChars', 8000);

      let remaining = budget;
      const sections: string[] = [];
      for (const item of results) {
        if (remaining <= 0) break;
        const header = `--- ${path.relative(workspace.uri.fsPath, item.filePath)} ---\n`;
        const body = item.content.slice(0, Math.max(0, remaining - header.length));
        sections.push(header + body);
        remaining -= header.length + body.length;
      }

      return (
        `${prompt}\n\n[Possibly relevant code from the index. It may be incomplete or ` +
        `wrong — use glob, grep and read_file to confirm and to find anything missing.]\n\n` +
        sections.join('\n\n')
      );
    } catch (error) {
      // Seeding is an optimisation; a failure here must not prevent the run.
      this.logger.debug('Could not seed initial context', { error: String(error) });
      return prompt;
    }
  }

  cancel(runId: string): void {
    this.active.get(runId)?.cancellation.cancel();
  }

  /** Runs currently in flight or parked awaiting approval. */
  getRunningRunIds(): string[] {
    return [...this.active.keys()];
  }

  // ── The loop ───────────────────────────────────────────────

  private async loop(
    state: RunState,
    provider: LlmProvider,
    workspace: vscode.WorkspaceFolder,
    mode: TaskMode,
  ): Promise<AgentRun> {
    const config = vscode.workspace.getConfiguration('repo-intelligence');
    const maxTurns = config.get<number>('agent.maxTurns', 30);
    const ignorePatterns = config.get<string[]>('agent.ignorePatterns', []);
    // Knowing which files are already dirty materially improves targeting — those are
    // almost always what the user is working on. Read once per run, not per turn: the
    // system prompt sits at the front of the cached prefix and must not vary between turns.
    const git = gitServiceFor(workspace);
    const system = buildSystemPrompt(mode, {
      name: workspace.name,
      gitBranch: git?.getCurrentBranch(),
      dirtyFiles: git?.getDirtyFiles(),
    });
    const token = state.cancellation.token;

    // Detects a model looping on the same call — usually a tool erroring identically each
    // time, which no number of further turns will fix.
    let lastSignature = '';
    let repeats = 0;

    try {
      while (state.turn < maxTurns) {
        if (token.isCancellationRequested) return this.finish(state, 'cancelled', 'Cancelled.');

        state.turn++;
        this.events.emit('agent:turnStarted', {
          runId: state.run.id,
          turn: state.turn,
          maxTurns,
        });

        const result = await provider.streamTurn({
          system,
          messages: state.transcript.all(),
          tools: this.registry.schemas(),
          maxTokens: config.get<number>('agent.maxOutputTokens', 16_000),
          token,
          onEvent: (event) => this.forward(state.run.id, event),
        });

        state.usage.inputTokens += result.usage.inputTokens;
        state.usage.outputTokens += result.usage.outputTokens;
        state.usage.cacheReadTokens += result.usage.cacheReadTokens ?? 0;

        // Replayed verbatim: thinking blocks must go back byte-identical, and server-side
        // compaction state rides along in the provider's own representation.
        state.transcript.push(
          (result.raw as LlmMessage | undefined) ?? { role: 'assistant', content: result.content },
        );
        this.persistTranscript(state);

        if (result.stopReason === 'cancelled') return this.finish(state, 'cancelled', 'Cancelled.');
        if (result.stopReason === 'refusal') {
          return this.finish(state, 'failed', 'The model declined this request.');
        }

        const toolUses = result.content.filter(
          (block): block is Extract<LlmContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
        );

        if (!toolUses.length) {
          // A turn that ends without the agent ever having looked at the repository is
          // almost always the "please tell me where footer.ts is" failure — it has glob,
          // grep and query_index, and asking the user is strictly slower than searching.
          // Nudged at most once per run, so a model that genuinely has nothing to do
          // still terminates on the next turn rather than looping.
          if (shouldNudgeToSearch(state)) {
            state.nudgedToSearch = true;
            state.transcript.push({ role: 'user', content: SEARCH_FIRST_NUDGE });
            continue;
          }
          return this.finish(state, 'completed', textOf(result.content));
        }

        const signature = toolUses.map((call) => `${call.name}:${JSON.stringify(call.input)}`).join('|');
        repeats = signature === lastSignature ? repeats + 1 : 0;
        lastSignature = signature;
        if (repeats >= 2) {
          state.transcript.push({
            role: 'user',
            content:
              '[You have made the same tool call three times in a row and are not making ' +
              'progress. Stop and explain what you were trying to do and what is blocking you.]',
          });
          continue;
        }

        const context: ToolContext = {
          workspace,
          fileState: state.fileState,
          database: this.container.database,
          searchEngine: this.container.hybridSearchEngine,
          token,
          turn: state.turn,
          ignorePatterns,
        };

        const pending = await this.executeTurn(state, toolUses, context, mode);

        if (Object.keys(pending.awaiting).length > 0) {
          state.pending = pending;
          this.persistPending(state);
          this.events.emit('agent:approvalRequired', {
            runId: state.run.id,
            changeSetIds: subjectIds(pending, 'file'),
            commandIds: subjectIds(pending, 'command'),
          });
          return this.park(state, textOf(result.content));
        }

        state.transcript.push(toolResultMessage(pending));
        if (state.transcript.shouldCompact()) {
          const removed = state.transcript.compact();
          if (removed) this.logger.info(`Compacted agent transcript: dropped ${removed} messages.`);
        }
      }

      return this.finish(
        state,
        'completed',
        `Stopped after ${maxTurns} turns without finishing. Increase ` +
          '"repo-intelligence.agent.maxTurns" or narrow the task.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.emit('agent:error', { runId: state.run.id, message });
      return this.finish(state, 'failed', message);
    }
  }

  /**
   * Runs every tool call from one assistant turn. Auto-approved tools execute immediately;
   * writes and commands become proposals recorded in `awaiting`.
   *
   * Auto tools run sequentially rather than concurrently: several edits proposed in one
   * turn can touch the same file, and interleaved reads would race the staleness check.
   */
  private async executeTurn(
    state: RunState,
    toolUses: Array<Extract<LlmContentBlock, { type: 'tool_use' }>>,
    context: ToolContext,
    mode: TaskMode,
  ): Promise<PendingTurnState> {
    const pending: PendingTurnState = {
      toolUseIds: toolUses.map((call) => call.id),
      resolved: {},
      awaiting: {},
    };

    for (const call of toolUses) {
      const outcome = await this.registry.execute(call.name, call.input, context, mode);

      // Counted on attempt rather than on success: a search that returned nothing still
      // means the agent looked, and it should report that instead of being nudged again.
      if (DISCOVERY_TOOLS.has(call.name)) state.discoveryToolsUsed++;

      if (outcome.kind === 'result') {
        pending.resolved[call.id] = { content: outcome.content, isError: outcome.isError };
        this.events.emit('agent:toolCallResult', {
          runId: state.run.id,
          toolCallId: call.id,
          name: call.name,
          ok: !outcome.isError,
          preview: preview(outcome.content),
        });
        continue;
      }

      if (outcome.kind === 'file-proposal') {
        const change: ChangeSet = {
          id: crypto.randomUUID(),
          runId: state.run.id,
          workspaceUri: context.workspace.uri.toString(),
          summary: outcome.summary,
          operations: [outcome.operation],
          status: 'proposed',
          createdAt: Date.now(),
        };
        this.pendingChangeSets.set(change.id, change);
        this.container.database.run(
          'INSERT INTO change_sets (id, run_id, workspace_uri, summary, operations_json, status, created_at, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            change.id,
            change.runId,
            change.workspaceUri,
            change.summary,
            JSON.stringify(change.operations),
            change.status,
            change.createdAt,
            call.id,
          ],
        );
        pending.awaiting[call.id] = { kind: 'file', subjectId: change.id, name: call.name };
        continue;
      }

      const request: CommandRequest = {
        ...outcome.request,
        id: crypto.randomUUID(),
        runId: state.run.id,
      };
      this.pendingCommands.set(request.id, request);
      const now = Date.now();
      this.container.database.run(
        'INSERT INTO command_requests (id, run_id, workspace_uri, command, args_json, cwd, reason, risk, status, created_at, updated_at, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          request.id,
          request.runId,
          request.workspaceUri,
          request.command,
          JSON.stringify(request.args),
          request.cwd,
          request.reason,
          request.risk,
          request.status,
          now,
          now,
          call.id,
        ],
      );
      pending.awaiting[call.id] = { kind: 'command', subjectId: request.id, name: call.name };
    }

    this.container.database.save();
    return pending;
  }

  // ── Approval ───────────────────────────────────────────────

  async approveChangeSet(id: string): Promise<void> {
    const change = this.pendingChangeSets.get(id);
    if (!change) throw new Error('No pending change set found.');

    await this.container.changeSetService.apply(change);
    this.pendingChangeSets.delete(id);

    // The agent may keep editing an approved file, so its tracked hash must match what is
    // now on disk rather than what it read before the edit.
    const state = this.active.get(change.runId);
    for (const operation of change.operations) {
      if (state && operation.content !== undefined && operation.kind !== 'delete') {
        state.fileState.recordWrite(operation.path, operation.content, state.turn);
      } else {
        state?.fileState.invalidate(operation.path);
      }
    }

    await this.resolve(change.runId, id, {
      content: `Applied: ${change.summary}`,
    });
  }

  async rejectChangeSet(id: string): Promise<void> {
    const change = this.pendingChangeSets.get(id);
    if (!change) throw new Error('No pending change set found.');

    this.container.changeSetService.reject(change);
    this.pendingChangeSets.delete(id);

    // A rejected proposal still owes a tool_result — an unanswered tool_use is a hard API
    // error. It is reported as an error so the model treats it as a correction.
    await this.resolve(change.runId, id, {
      content: `The user rejected this change: ${change.summary}. Do not propose it again unchanged.`,
      isError: true,
    });
  }

  async approveCommand(id: string): Promise<string> {
    const request = this.pendingCommands.get(id);
    if (!request) throw new Error('No pending command found.');

    this.pendingCommands.delete(id);
    let output: string;
    let failed = false;
    try {
      output = await this.container.commandRunner.run(request);
    } catch (error) {
      // A failing command is information the agent needs, not a reason to end the run —
      // failing tests are frequently the whole point of running them.
      output = error instanceof Error ? error.message : String(error);
      failed = true;
    }

    await this.resolve(request.runId, id, { content: truncate(output), isError: failed });
    return output;
  }

  async rejectCommand(id: string): Promise<void> {
    const request = this.pendingCommands.get(id);
    if (!request) throw new Error('No pending command found.');

    this.container.commandRunner.reject(request);
    this.pendingCommands.delete(id);

    await this.resolve(request.runId, id, {
      content: `The user declined to run "${request.command} ${request.args.join(' ')}".`,
      isError: true,
    });
  }

  /**
   * Records one decision. When it was the last outstanding proposal for the parked turn,
   * the tool results are assembled in their original order and the loop continues.
   */
  private async resolve(
    runId: string,
    subjectId: string,
    outcome: { content: string; isError?: boolean },
  ): Promise<void> {
    const state = this.active.get(runId);
    if (!state?.pending) return;

    const entry = Object.entries(state.pending.awaiting).find(
      ([, value]) => value.subjectId === subjectId,
    );
    if (!entry) return;

    const [toolUseId, awaited] = entry;
    delete state.pending.awaiting[toolUseId];
    state.pending.resolved[toolUseId] = outcome;

    this.events.emit('agent:toolCallResult', {
      runId,
      toolCallId: toolUseId,
      name: awaited.name,
      ok: !outcome.isError,
      preview: preview(outcome.content),
    });

    if (Object.keys(state.pending.awaiting).length > 0) {
      this.persistPending(state);
      return;
    }

    state.transcript.push(toolResultMessage(state.pending));
    state.pending = undefined;
    this.persistPending(state);

    const workspace = vscode.workspace.workspaceFolders?.find(
      (folder) => folder.uri.toString() === state.run.task.workspaceUri,
    );
    const resolved = await this.container.providerFactory.resolveChatProvider();
    if (!workspace || !resolved) {
      this.finish(state, 'failed', 'Workspace or model provider is no longer available.');
      return;
    }

    state.run.status = 'running';
    await this.loop(state, resolved.provider, workspace, state.run.task.mode);
  }

  // ── Persistence and lifecycle ──────────────────────────────

  private park(state: RunState, response: string): AgentRun {
    state.run.status = 'awaiting_approval';
    state.run.response = response || 'Prepared changes for your review.';
    state.run.updatedAt = Date.now();
    this.persistRun(state);
    return state.run;
  }

  private finish(state: RunState, status: AgentRunStatus, response: string): AgentRun {
    state.run.status = status;
    state.run.response = response;
    state.run.updatedAt = Date.now();
    this.persistRun(state);
    this.persistTranscript(state);

    this.events.emit('agent:runFinished', {
      runId: state.run.id,
      status,
      turns: state.turn,
      usage: state.usage,
    });

    state.cancellation.dispose();
    this.active.delete(state.run.id);
    return state.run;
  }

  private persistRun(state: RunState): void {
    this.container.database.run(
      'UPDATE agent_runs SET status = ?, response = ?, updated_at = ?, turn_count = ? WHERE id = ?',
      [state.run.status, state.run.response ?? null, state.run.updatedAt, state.turn, state.run.id],
    );
    this.container.database.save();
  }

  private persistTranscript(state: RunState): void {
    this.container.database.run('UPDATE agent_runs SET transcript_json = ? WHERE id = ?', [
      JSON.stringify(state.transcript.all()),
      state.run.id,
    ]);
  }

  private persistPending(state: RunState): void {
    this.container.database.run('UPDATE agent_runs SET pending_turn_json = ? WHERE id = ?', [
      state.pending ? JSON.stringify(state.pending) : null,
      state.run.id,
    ]);
    this.container.database.save();
  }

  private forward(runId: string, event: { type: string } & Record<string, unknown>): void {
    switch (event.type) {
      case 'text_delta':
        this.events.emit('agent:textDelta', { runId, text: String(event.text) });
        break;
      case 'thinking_delta':
        this.events.emit('agent:thinkingDelta', { runId, text: String(event.text) });
        break;
      case 'tool_use_start':
        this.events.emit('agent:toolCallStarted', {
          runId,
          toolCallId: String(event.id),
          name: String(event.name),
        });
        break;
      case 'tool_use_input':
        this.events.emit('agent:toolCallInput', {
          runId,
          toolCallId: String(event.id),
          partialJson: String(event.partialJson),
        });
        break;
      case 'error':
        this.events.emit('agent:error', { runId, message: String(event.message) });
        break;
      default:
        break;
    }
  }

  // ── Queries used by commands and the webview ───────────────

  getPendingChangeSets(): ChangeSet[] {
    return [...this.pendingChangeSets.values()];
  }

  getPendingCommands(): CommandRequest[] {
    return [...this.pendingCommands.values()];
  }

  revokeSessionTrust(workspaceUri?: string): void {
    const now = Date.now();
    if (workspaceUri) {
      this.container.database.run(
        'UPDATE agent_session_trust SET trusted = 0, updated_at = ? WHERE workspace_uri = ?',
        [now, workspaceUri],
      );
    } else {
      this.container.database.run('UPDATE agent_session_trust SET trusted = 0, updated_at = ?', [now]);
    }
    this.container.database.save();
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Builds the single user message answering a parked turn.
 *
 * All results go in ONE message, in the original tool_use order. Splitting them across
 * several messages trains the model out of making parallel tool calls, and leaves the
 * assistant turn partially unanswered in the meantime.
 */
export function toolResultMessage(pending: PendingTurnState): LlmMessage {
  const blocks: LlmToolResultBlock[] = pending.toolUseIds.map((id) => {
    const resolved = pending.resolved[id];
    return {
      type: 'tool_result',
      toolUseId: id,
      // A missing entry should be impossible, but an unanswered tool_use is a hard API
      // error — so failing closed with a placeholder beats omitting the block.
      content: resolved?.content ?? 'No result was produced for this tool call.',
      isError: resolved ? resolved.isError : true,
    };
  });
  return { role: 'user', content: blocks };
}

function subjectIds(pending: PendingTurnState, kind: 'file' | 'command'): string[] {
  return Object.values(pending.awaiting)
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.subjectId);
}

function textOf(content: LlmContentBlock[]): string {
  return content
    .filter((block): block is Extract<LlmContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function preview(content: string, limit = 200): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

function truncate(output: string, limit = 8000): string {
  if (output.length <= limit) return output;
  // Keep the tail: compiler and test output puts the summary at the end.
  return `[output truncated to the last ${limit} characters]\n…${output.slice(-limit)}`;
}
