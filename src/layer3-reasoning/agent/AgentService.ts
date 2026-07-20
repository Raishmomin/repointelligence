import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { AgentRun, AgentTask, ChangeSet, CommandRequest, FileOperation, TaskMode } from '../../shared/types/agent.types';
import { parseAgentEnvelope } from './AgentProtocol';
import { WorkspaceTools } from './WorkspaceTools';
import { isSafeCommand } from './AgentSafety';

export class AgentService {
  private pending = new Map<string, ChangeSet>();
  private pendingCommands = new Map<string, CommandRequest>();
  constructor(private readonly container: ServiceContainer) {}
  revokeSessionTrust(workspaceUri?: string): void {
    if (workspaceUri) this.container.database.run('UPDATE agent_session_trust SET trusted = 0, updated_at = ? WHERE workspace_uri = ?', [Date.now(), workspaceUri]);
    else this.container.database.run('UPDATE agent_session_trust SET trusted = 0, updated_at = ?', [Date.now()]);
    this.container.database.save();
  }

  async run(prompt: string, mode: TaskMode, workspace: vscode.WorkspaceFolder, sessionId?: string): Promise<AgentRun> {
    const now = Date.now(); const id = crypto.randomUUID();
    const task: AgentTask = { id, prompt, mode, workspaceUri: workspace.uri.toString(), sessionId };
    const run: AgentRun = { id, task, status: 'running', createdAt: now, updatedAt: now };
    this.container.database.run('INSERT INTO agent_runs (id, workspace_uri, session_id, mode, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, task.workspaceUri, sessionId ?? null, mode, prompt, run.status, now, now]);
    const tools = new WorkspaceTools(workspace);
    // Seed every agent run with deterministic index context. Tool calls remain available
    // for follow-up inspection, but small local models no longer have to guess to ask.
    const initialContext = await tools.queryIndex(prompt);
    const messages = [{ role: 'system', content: systemPrompt(mode) }, { role: 'user', content: `${prompt}\n\n[INITIAL REPOSITORY CONTEXT]\n${initialContext || 'No matching indexed code. Ask the user to scan the workspace rather than requesting pasted code.'}` }];
    const maxIterations = vscode.workspace.getConfiguration('repo-intelligence').get<number>('agent.maxIterations', 2);
    let response = '';
    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const envelope = parseAgentEnvelope(await this.container.ollamaClient.chatComplete(messages));
        response = envelope.response ?? response;
        const proposalCalls = envelope.toolCalls?.filter(call => call.name === 'propose_changes' || call.name === 'propose_command') ?? [];
        for (const call of proposalCalls) await this.captureProposal(run, workspace, tools, call);
        const executable = envelope.toolCalls?.filter(call => call.name !== 'propose_changes' && call.name !== 'propose_command') ?? [];
        if (!executable.length) break;
        const results = await Promise.all(executable.map(call => tools.execute(call)));
        messages.push({ role: 'assistant', content: JSON.stringify(envelope) }, { role: 'user', content: `TOOL_RESULTS:\n${JSON.stringify(results)}` });
      }
      const hasPending = [...this.pending.values()].some(change => change.runId === id) || [...this.pendingCommands.values()].some(command => command.runId === id);
      run.status = hasPending ? 'awaiting_approval' : 'completed'; run.response = response || (hasPending ? 'Prepared actions for review.' : 'No action was proposed.');
    } catch (error) { run.status = 'failed'; run.response = error instanceof Error ? error.message : String(error); }
    run.updatedAt = Date.now();
    this.container.database.run('UPDATE agent_runs SET status = ?, response = ?, updated_at = ? WHERE id = ?', [run.status, run.response, run.updatedAt, id]); this.container.database.save();
    return run;
  }

  private async captureProposal(run: AgentRun, workspace: vscode.WorkspaceFolder, tools: WorkspaceTools, call: any): Promise<void> {
    if (call.name === 'propose_changes') {
      const rawOps = Array.isArray(call.arguments.operations) ? call.arguments.operations : [];
      const operations: FileOperation[] = [];
      for (const op of rawOps) if (op && typeof op === 'object') operations.push(await tools.makeOperation(op as Record<string, unknown>));
      if (!operations.length) return;
      const max = vscode.workspace.getConfiguration('repo-intelligence').get<number>('agent.maxChangeSetSize', 20);
      if (operations.length > max) throw new Error(`Agent proposed ${operations.length} file operations; configured maximum is ${max}.`);
      const change: ChangeSet = { id: crypto.randomUUID(), runId: run.id, workspaceUri: workspace.uri.toString(), summary: String(call.arguments.summary ?? 'Agent-proposed changes'), operations, status: 'proposed', createdAt: Date.now() };
      this.pending.set(change.id, change);
      this.container.database.run('INSERT INTO change_sets (id, run_id, workspace_uri, summary, operations_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [change.id, run.id, change.workspaceUri, change.summary, JSON.stringify(change.operations), change.status, change.createdAt]);
    } else {
      const command = String(call.arguments.command ?? ''); const args = Array.isArray(call.arguments.args) ? call.arguments.args.filter((arg: unknown) => typeof arg === 'string') as string[] : [];
      if (!isSafeCommand(command, args)) throw new Error('Unsafe command proposal rejected. Commands must be executable plus literal arguments.');
      const request: CommandRequest = { id: crypto.randomUUID(), runId: run.id, workspaceUri: workspace.uri.toString(), command, args, cwd: workspace.uri.fsPath, reason: String(call.arguments.reason ?? 'Agent requested validation'), risk: classifyCommand(command, args), status: 'pending' };
      this.pendingCommands.set(request.id, request); const now = Date.now();
      this.container.database.run('INSERT INTO command_requests (id, run_id, workspace_uri, command, args_json, cwd, reason, risk, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [request.id, run.id, request.workspaceUri, command, JSON.stringify(args), request.cwd, request.reason, request.risk, request.status, now, now]);
    }
  }
  getPendingChangeSets(): ChangeSet[] { return [...this.pending.values()]; }
  getPendingCommands(): CommandRequest[] { return [...this.pendingCommands.values()]; }
  async approveChangeSet(id: string): Promise<void> { const change = this.pending.get(id); if (!change) throw new Error('No pending change set found.'); await this.container.changeSetService.apply(change); this.pending.delete(id); }
  rejectChangeSet(id: string): void { const change = this.pending.get(id); if (!change) throw new Error('No pending change set found.'); this.container.changeSetService.reject(change); this.pending.delete(id); }
  async approveCommand(id: string): Promise<string> { const command = this.pendingCommands.get(id); if (!command) throw new Error('No pending command found.'); const output = await this.container.commandRunner.run(command); this.pendingCommands.delete(id); return output; }
  rejectCommand(id: string): void { const command = this.pendingCommands.get(id); if (!command) throw new Error('No pending command found.'); this.container.commandRunner.reject(command); this.pendingCommands.delete(id); }
}
function classifyCommand(command: string, args: string[]) { return /^(git|npm|pnpm|yarn|curl|wget|ssh|rm|mv)$/i.test(command) || args.some(arg => /install|remove|delete|reset|push|publish/i.test(arg)) ? 'high' : 'medium'; }
function systemPrompt(mode: TaskMode): string { return `You are a local VS Code coding agent in ${mode.toUpperCase()} mode. Return ONLY JSON: {"response":"user-facing concise text","toolCalls":[{"id":"unique","name":"read_file|search_files|query_index|propose_changes|propose_command","arguments":{}}]}. INITIAL REPOSITORY CONTEXT is supplied with every request: use it directly and do not ask the user to paste code that is already present there. Use tools only to inspect additional files before claiming facts. In explain/plan mode never propose changes or commands. In implement mode, do not return standalone CSS/code as an answer. You must inspect the relevant file and return one propose_changes tool call containing the complete replacement content for every affected file; the extension will show a diff and ask for approval. If no relevant code is indexed, ask the user to run Scan Repository. Never propose shell strings, pipes, redirects, or package installs. Commands require propose_command with executable command and literal args.`; }
