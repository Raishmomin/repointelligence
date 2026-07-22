// ═══════════════════════════════════════════════════════════════
// Chat Webview Provider — Sidebar Interactive Chat UI Panel
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { Logger } from '../../shared/Logger';
import { ProposalContentProvider } from './ProposalContentProvider';
import { AgentStreamBridge } from './AgentStreamBridge';
import { buildReactHtml, isReactUiEnabled } from './ReactWebviewHost';
import { ProviderRpcHandler } from './ProviderRpcHandler';
import type {
  AgentStreamStep,
  ExtensionToWebview,
  RpcMethod,
  TaskModeDto,
} from '../../shared/types/webview.types';
import { EventBus } from '../../shared/EventBus';
import { ChatMessage } from '../../shared/types/context.types';
import { AgentRun, ChangeSet, CommandRequest } from '../../shared/types/agent.types';

// Session and message SQL now lives in ChatRepository. The mapping to the protocol's
// camelCase shape happens there too, which is what the messageContract test guards.

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private logger = Logger.getInstance();
  private container = ServiceContainer.getInstance();
  private activeSessionId: string | null = null;
  private activeProjectId: string | null = null;

  private readonly agentStream = new AgentStreamBridge(message => {
    this.rememberSteps(message.runId, message.steps);
    this.postToWebview(message);
  });
  /**
   * Steps already delivered, per run.
   *
   * `retainContextWhenHidden` covers hiding the view, but a window reload or an extension
   * restart still remounts the webview with empty state. Without a replay the timeline
   * comes back blank even though the run happened.
   */
  private readonly deliveredSteps = new Map<string, AgentStreamStep[]>();
  private readonly rpcHandler = new ProviderRpcHandler(this.container.providerFactory);
  private activeMode: TaskModeDto = 'implement';
  /** Set when a run was served by a fallback, so the composer bar can flag it. */
  private lastFallbackFrom: string | undefined;

  constructor() {
    const events = EventBus.getInstance();

    events.on('scan:completed', async (result) => {
      this.activeProjectId = result.projectId;
      await this.handleReady();
    });

    // Which backend actually served the last run. A fallback changes it silently, so the
    // composer bar has to be told rather than inferring it from configuration.
    events.on('provider:resolved', payload => {
      this.lastFallbackFrom = payload.reason === 'fallback' ? payload.fallbackFrom : undefined;
      void this.pushModelState();
    });

    events.on('provider:changed', () => {
      this.rpcHandler.getCatalog().invalidate();
      void this.pushModelState(true);
    });

    // Approvals appear mid-run, not in response to anything the panel asked for.
    events.on('agent:approvalRequired', () => this.pushApprovals());
    events.on('agent:runFinished', () => this.pushApprovals());
  }

  private rememberSteps(runId: string, steps: AgentStreamStep[]): void {
    const existing = this.deliveredSteps.get(runId) ?? [];
    this.deliveredSteps.set(runId, [...existing, ...steps]);

    // Only the most recent runs are worth replaying; an unbounded map would grow for the
    // lifetime of the window.
    while (this.deliveredSteps.size > 3) {
      const oldest = this.deliveredSteps.keys().next().value;
      if (oldest === undefined) break;
      this.deliveredSteps.delete(oldest);
    }
  }

  /** Re-sends recent runs after a remount, in their original order. */
  private replayTimeline(): void {
    for (const [runId, steps] of this.deliveredSteps) {
      this.postToWebview({ type: 'agentStream', runId, steps });
    }
  }

  public dispose(): void {
    this.agentStream.dispose();
  }

  // ── Model and provider surface ─────────────────────────────

  /** Pushes the composer bar's state and the full model catalogue. */
  private async pushModelState(force = false): Promise<void> {
    try {
      const catalog = this.rpcHandler.getCatalog();
      const state = catalog.state(this.activeMode);
      const models = await catalog.list(force);
      this.postToWebview({ type: 'modelState', state: { ...state, fallbackFrom: this.lastFallbackFrom }, models });
    } catch (error) {
      this.logger.warn('Could not build the model catalogue', { error: String(error) });
    }
  }

  /**
   * Switches model, and provider with it when the chosen model belongs to another one.
   *
   * Routed through setChatModel rather than save() so the provider's other settings —
   * base URL, context window — survive the switch.
   */
  private async handleSelectModel(providerId: string, modelId: string): Promise<void> {
    await this.rpcHandler.getSetup().setChatModel(providerId, modelId);
    this.rpcHandler.getCatalog().invalidate();
    // A deliberate switch clears any stale fallback badge.
    this.lastFallbackFrom = undefined;
    await this.pushModelState(true);
  }

  /** Change sets and commands waiting on the user, for the approval cards. */
  private pushApprovals(): void {
    const changes = this.container.agentService.getPendingChangeSets().map(change => ({
      changeSetId: change.id,
      summary: change.summary,
      paths: change.operations.map(op => op.path),
      risk: change.operations[0]?.risk ?? 'low',
    }));

    const commands = this.container.agentService.getPendingCommands().map(command => ({
      commandId: command.id,
      summary: `${command.command} ${command.args.join(' ')} — ${command.reason}`,
      paths: [],
      risk: command.risk,
    }));

    this.postToWebview({ type: 'approvals', approvals: [...changes, ...commands] });
  }

  /**
   * Answers a correlated request.
   *
   * Replies on every path including a throw — postMessage is fire-and-forget, so a handler
   * that returns without replying leaves a pending entry and its timer alive in the webview
   * for the rest of the session.
   */
  private async handleRpc(requestId: string, method: RpcMethod, params: unknown): Promise<void> {
    try {
      const payload = await this.rpcHandler.handle(method, params);
      this.postToWebview({ type: 'rpcResponse', requestId, ok: true, payload });
    } catch (error) {
      this.postToWebview({
        type: 'rpcResponse',
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Trigger a programmatic prompt from editor context commands */
  public handleProgrammaticPrompt(text: string): void {
    if (this._view) {
      this._view.show(true);
      // Wait for a tiny bit for the webview to be fully active/loaded
      setTimeout(() => {
        this.handleAgentMessage(text, 'implement').catch(err => {
          this.logger.error('Failed to execute programmatic prompt', err);
        });
      }, 500);
    }
  }

  /** Publishes the auditable agent timeline to the existing chat surface. */
  public showAgentRun(run: AgentRun, changes: ChangeSet[], commands: CommandRequest[]): void {
    // Legacy webview only. The React panel already renders this run three other ways —
    // the live stream, the recorded assistant bubble, and approval cards — so this blob
    // was a third copy of the same reply stacked under the other two.
    if (isReactUiEnabled()) return;

    const actions = [
      ...changes.map(change => `- Pending change set: ${change.summary} (${change.operations.length} file operation(s))`),
      ...commands.map(command => `- Pending command approval: \`${command.command} ${command.args.join(' ')}\` — ${command.reason}`),
    ];
    this.postToWebview({ type: 'agentTimeline', content: `### Agent ${run.task.mode}\n${run.response ?? ''}${actions.length ? `\n\n${actions.join('\n')}` : ''}` });
  }

  public showAgentLog(output: string): void { this.postToWebview({ type: 'agentTimeline', content: `### Agent command output\n\n\`\`\`\n${output}\n\`\`\`` }); }

  public async showAgentDiff(changeSetId: string, relativePath: string): Promise<void> {
    const stored = this.container.database.queryOne<{ operations_json: string; workspace_uri: string }>('SELECT operations_json, workspace_uri FROM change_sets WHERE id = ?', [changeSetId]);
    if (!stored) throw new Error('Change set was not found.');
    const operation = (JSON.parse(stored.operations_json) as Array<{ kind: string; path: string; content?: string }>).find(item => item.path === relativePath);
    if (!operation) throw new Error('File operation was not found.');
    const workspace = vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === stored.workspace_uri);
    if (!workspace) throw new Error('Selected workspace is no longer open.');
    const original = vscode.Uri.joinPath(workspace.uri, relativePath);
    // Served from memory by ProposalContentProvider rather than written to a temp file:
    // reviewing a change should not leave anything on disk.
    const proposed = ProposalContentProvider.uriFor(changeSetId, relativePath);
    const label = operation.kind === 'create' ? 'New file' : 'Current \u2194 Agent Proposal';
    await vscode.commands.executeCommand('vscode.diff', original, proposed, `${relativePath}: ${label}`);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    this.logger.info('resolveWebviewView called — setting up webview');

    const useReact = isReactUiEnabled();
    webviewView.webview.options = {
      enableScripts: true,
      // Narrowed to the built UI only when React is serving it. The legacy inline HTML
      // loads no local resources at all, but keeping the broad root would leave the whole
      // extension directory readable from the webview for no reason.
      localResourceRoots: useReact
        ? [vscode.Uri.joinPath(this.container.extensionContext.extensionUri, 'out', 'webview')]
        : [this.container.extensionContext.extensionUri],
    };

    webviewView.webview.html = useReact
      ? buildReactHtml(webviewView.webview, this.container.extensionContext.extensionUri)
      : this.getHtmlContent(webviewView.webview);
    this.logger.info(`Webview HTML set (${useReact ? 'react' : 'legacy'})`);

    // Register messages listener
    webviewView.webview.onDidReceiveMessage(async (message) => {
      this.logger.info('Received webview message', { type: message.type });
      try {
        switch (message.type) {
          case 'ready':
            await this.handleReady();
            break;
          case 'sendMessage':
            await this.handleSendMessage(message.text);
            break;
          case 'sendAgentMessage':
            await this.handleAgentMessage(message.text, message.mode);
            break;
          case 'newSession':
            await this.handleNewSession();
            break;
          case 'selectSession':
            await this.handleSelectSession(message.sessionId);
            break;
          case 'deleteSession':
            await this.handleDeleteSession(message.sessionId);
            break;
          case 'setMode':
            this.activeMode = message.mode;
            await this.pushModelState();
            break;
          case 'selectModel':
            await this.handleSelectModel(message.providerId, message.modelId);
            break;
          case 'refreshModels':
            await this.pushModelState(true);
            break;
          case 'cancelRun':
            this.container.agentService.getRunningRunIds().forEach(id => this.container.agentService.cancel(id));
            this.pushApprovals();
            break;
          case 'retryMessage':
            await this.handleRetry();
            break;
          case 'approveChangeSet':
            await this.container.agentService.approveChangeSet(message.changeSetId);
            this.pushApprovals();
            break;
          case 'rejectChangeSet':
            await this.container.agentService.rejectChangeSet(message.changeSetId);
            this.pushApprovals();
            break;
          case 'approveCommand':
            this.showAgentLog(await this.container.agentService.approveCommand(message.commandId));
            this.pushApprovals();
            break;
          case 'rejectCommand':
            await this.container.agentService.rejectCommand(message.commandId);
            this.pushApprovals();
            break;
          case 'openDiff':
            await this.showAgentDiff(message.changeSetId, message.path);
            break;
          case 'rpcRequest':
            await this.handleRpc(message.requestId, message.method, message.params);
            break;
        }
      } catch (error) {
        this.logger.error('Error handling webview message', error);
        this.postToWebview({ type: 'status', status: 'idle' });
        webviewView.webview.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private async handleReady(): Promise<void> {
    // The composer bar needs these before anything else renders, and they do not depend on
    // a scanned project.
    void this.pushModelState();
    this.pushApprovals();
    this.replayTimeline();

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const currentWorkspacePath = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : null;

    let project = null;
    if (currentWorkspacePath) {
      project = this.container.database.queryOne<{ id: string }>(
        'SELECT id FROM projects WHERE root_path = ?',
        [currentWorkspacePath]
      );
    }

    if (!project) {
      if (currentWorkspacePath) {
        this.logger.info('Current workspace not found in database. Triggering automatic scan...', { path: currentWorkspacePath });
        vscode.commands.executeCommand('repo-intelligence.scanRepository');
      }

      project = this.container.database.queryOne<{ id: string }>(
        'SELECT id FROM projects ORDER BY last_scan DESC LIMIT 1'
      );
    }
    
    if (project) {
      this.activeProjectId = project.id;
    }

    if (!this.activeProjectId) {
      this.postToWebview({ type: 'status', status: 'no-project' });
      return;
    }

    // Send active project info to webview
    const projectDetails = this.container.database.queryOne<{ name: string; framework: string }>(
      'SELECT name, framework FROM projects WHERE id = ?',
      [this.activeProjectId]
    );
    if (projectDetails) {
      this.postToWebview({
        type: 'projectInfo',
        name: projectDetails.name,
        framework: projectDetails.framework
      });
    }

    const sessions = this.container.chatRepository.listSessions(this.activeProjectId);

    if (sessions.length > 0) {
      this.activeSessionId = sessions[0].id;
      await this.loadActiveSessionMessages();
      this.pushSessions();
    } else {
      // handleNewSession pushes the list itself, so re-querying here would be redundant.
      await this.handleNewSession();
    }

    // Send Ollama health status
    const health = await this.container.ollamaClient.checkHealth();
    this.postToWebview({ type: 'ollamaHealth', health });
  }

  /** Pushes the session list with whichever session is currently active. */
  private pushSessions(): void {
    if (!this.activeProjectId) return;
    this.postToWebview({
      type: 'sessions',
      sessions: this.container.chatRepository.listSessions(this.activeProjectId),
      activeSessionId: this.activeSessionId,
    });
  }

  private async handleNewSession(): Promise<void> {
    if (!this.activeProjectId) return;

    this.activeSessionId = this.container.chatRepository.createSession(this.activeProjectId);
    this.pushSessions();
    this.postToWebview({ type: 'messages', messages: [] });
  }

  private async handleSelectSession(sessionId: string): Promise<void> {
    this.activeSessionId = sessionId;
    await this.loadActiveSessionMessages();
    // Re-pushed so the panel's active marker follows the host. Without this the two
    // disagree about which session is selected as soon as the user switches.
    this.pushSessions();
  }

  private async handleDeleteSession(sessionId: string): Promise<void> {
    this.container.chatRepository.deleteSession(sessionId);

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      await this.handleReady();
    } else {
      this.pushSessions();
    }
  }

  /**
   * Appends one message to the active session and pushes the updated conversation.
   *
   * Persisting rather than only posting is what makes the transcript survive a reload:
   * the webview holds no durable state of its own.
   */
  private async recordMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    if (!this.activeSessionId) return;

    this.container.chatRepository.addMessage(this.activeSessionId, role, content);

    // Name the session after its opening prompt. This previously lived only in the legacy
    // handleSendMessage path, so every session started from the React panel kept the
    // placeholder title — which made a session list useless the moment you had two.
    if (role === 'user' && this.container.chatRepository.titleFromFirstMessage(this.activeSessionId, content)) {
      this.pushSessions();
    }

    await this.loadActiveSessionMessages();
  }

  private async loadActiveSessionMessages(): Promise<void> {
    if (!this.activeSessionId) return;

    this.postToWebview({
      type: 'messages',
      messages: this.container.chatRepository.listMessages(this.activeSessionId),
    });
  }

  private async handleSendMessage(text: string): Promise<void> {
    if (!this.activeSessionId || !this.activeProjectId) {
      throw new Error('No active session or project context.');
    }

    this.postToWebview({ type: 'status', status: 'thinking', message: 'Understanding your request…' });

    // Persist, title and reload — the same path the agent flow uses, so the two cannot
    // drift again.
    await this.recordMessage('user', text);

    // 2. Fetch history context
    const dbMessages = this.container.database.query<{ id: string; role: string; content: string; created_at: number }>(
      'SELECT id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC',
      [this.activeSessionId]
    );
    const history: ChatMessage[] = dbMessages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      timestamp: m.created_at,
    }));

    // Get active file
    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor?.document.uri.fsPath;
    const activeFileContent = activeEditor?.document.getText();

    // 3. Retrieve Context Files & Assemble
    this.postToWebview({ type: 'status', status: 'retrieving-context', message: 'Locating relevant files, including the active editor…' });

    const maxTokens = vscode.workspace.getConfiguration('repo-intelligence').get<number>('context.maxTokens', 4096);
    const retrievedContext = await this.container.contextAssembler.assemble(
      this.activeProjectId,
      {
        type: 'chat',
        userMessage: text,
        activeFile,
        activeFileContent,
        maxTokens,
        conversationHistory: history.slice(0, -1), // Exclude last user prompt we just added
      }
    );

    // Build final prompt
    const builtPrompt = this.container.promptBuilder.build(
      { type: 'chat', userMessage: text, maxTokens },
      retrievedContext,
      'chat'
    );

    // Send context feedback to UI
    this.postToWebview({
      type: 'contextInfo',
      files: retrievedContext.files.map(f => f.relativePath),
      tokensUsed: retrievedContext.totalTokens,
    });

    // 4. Start streaming response
    this.postToWebview({ type: 'status', status: 'generating', message: `Reading ${retrievedContext.files.length} relevant file${retrievedContext.files.length === 1 ? '' : 's'} and preparing an answer…` });

    let fullResponse = '';
    await this.container.ollamaClient.chatStream(
      builtPrompt.messages,
      (chunk) => {
        fullResponse += chunk;
        this.postToWebview({ type: 'streamChunk', chunk });
      }
    );

    // 5. Save assistant response to DB
    await this.recordMessage('assistant', fullResponse);

    this.postToWebview({ type: 'status', status: 'idle' });
  }

  /** Main sidebar path: requests become auditable agent runs, not free-form code snippets. */
  private async handleAgentMessage(text: string, rawMode: unknown): Promise<void> {
    // Record the prompt before the run starts. The agent path previously wrote nothing to
    // chat_messages, so your own message never appeared and nothing survived a reload.
    await this.recordMessage('user', text);
    await this.startAgentRun(text, rawMode);
  }

  /**
   * Re-runs the session's last prompt.
   *
   * The prompt is already recorded, so this deliberately does not go through
   * handleAgentMessage — doing so would write a second copy of it. Each agent run builds
   * its transcript from the prompt alone and carries nothing over from the previous run,
   * so a retry is a genuinely fresh attempt rather than a continuation.
   */
  private async handleRetry(): Promise<void> {
    if (!this.activeSessionId) return;

    const prompt = this.container.chatRepository.rewindToLastUserMessage(this.activeSessionId);
    if (!prompt) return;

    await this.loadActiveSessionMessages();
    await this.startAgentRun(prompt, this.activeMode);
  }

  private async startAgentRun(text: string, rawMode: unknown): Promise<void> {
    const mode = rawMode === 'explain' || rawMode === 'plan' || rawMode === 'implement' ? rawMode : 'implement';
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw new Error('Open a workspace folder before starting the coding agent.');
    const workspace = folders.length === 1
      ? folders[0]
      : await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { placeHolder: 'Choose the workspace folder for this agent task' }).then(item => item?.folder);
    if (!workspace) return;

    this.postToWebview({ type: 'status', status: 'thinking', message: mode === 'implement' ? 'Inspecting your project and preparing a reviewed change set…' : 'Inspecting your project…' });
    const run = await this.container.agentService.run(text, mode, workspace, this.activeSessionId ?? undefined);

    // A completed run always records a reply. Without the fallback line, a model that
    // produced no text across the whole run leaves the timeline showing only "worked for
    // N turns" and nothing else — which reads as the extension eating the answer.
    if (run.response) {
      await this.recordMessage('assistant', run.response);
    } else if (run.status === 'completed') {
      await this.recordMessage('assistant', '(The model finished without producing a reply — try rephrasing, or a larger model.)');
    }
    this.showAgentRun(run, this.container.agentService.getPendingChangeSets(), this.container.agentService.getPendingCommands());
    this.postToWebview({ type: 'status', status: 'idle' });
    if (run.status === 'awaiting_approval') {
      vscode.window.showInformationMessage('Agent prepared a change set. Review it from the Repo Intelligence command palette before applying.');
    }
  }

  /**
   * Typed on purpose. This was `any`, which is how a message declaring `timestamp` reached
   * a webview expecting `createdAt` and failed only at runtime — the compiler now rejects
   * any shape not in the shared protocol.
   */
  private postToWebview(message: ExtensionToWebview): void {
    this._view?.webview.postMessage(message);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <title>Repository Chat</title>
  <style nonce="${nonce}">
    body {
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--vscode-font-size, 13px);
      margin: 0; padding: 0;
      display: flex; flex-direction: column;
      height: 100vh; overflow: hidden;
    }

    header {
      padding: 8px 12px;
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-title {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      letter-spacing: 0.5px;
    }
    #projectBadge {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      display: none; margin-top: 1px;
    }

    button.icon-btn {
      background: transparent;
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border));
      color: var(--vscode-foreground);
      padding: 3px 8px; border-radius: 3px;
      cursor: pointer; font-size: 11px;
    }
    button.icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .main-container {
      display: flex; flex-direction: column; flex: 1; overflow: hidden;
    }

    .sessions-bar {
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex; align-items: center; gap: 6px;
    }
    .sessions-bar select {
      flex: 1;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      color: var(--vscode-dropdown-foreground);
      padding: 3px 6px; border-radius: 3px; outline: none;
      font-size: 11px;
    }
    .agent-mode {
      width: 100%; box-sizing: border-box; margin: 0; padding: 5px 10px;
      background: var(--vscode-sideBar-background); color: var(--vscode-foreground);
      border: 0; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px;
    }
    .delete-btn {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-errorForeground);
      padding: 2px 6px; border-radius: 3px;
      cursor: pointer; font-size: 11px;
    }
    .delete-btn:hover {
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
    }

    .chat-area {
      flex: 1; overflow-y: auto; padding: 0;
      display: flex; flex-direction: column;
    }

    .msg {
      padding: 10px 14px; font-size: 13px; line-height: 1.6;
      word-wrap: break-word;
    }
    .msg.user {
      background: var(--vscode-input-background);
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .msg.assistant {
      background: transparent;
    }

    .msg-content h1, .msg-content h2, .msg-content h3 {
      margin: 10px 0 4px 0; font-weight: 600;
    }
    .msg-content h1 { font-size: 1.2em; }
    .msg-content h2 { font-size: 1.1em; }
    .msg-content h3 { font-size: 1.0em; }
    .msg-content ul, .msg-content ol { margin: 6px 0; padding-left: 18px; }
    .msg-content li { margin: 3px 0; list-style-type: disc; }

    .msg-content pre {
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      padding: 8px 10px; border-radius: 4px; overflow-x: auto;
      border: 1px solid var(--vscode-panel-border); margin: 6px 0;
    }
    .msg-content code {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.15));
      padding: 1px 4px; border-radius: 3px;
    }

    .context-pill {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      padding: 3px 10px; display: none;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .input-area {
      padding: 10px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex; gap: 6px; align-items: flex-end;
    }
    .input-area textarea {
      flex: 1;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground);
      padding: 8px 10px; border-radius: 4px;
      resize: none; height: 20px; max-height: 100px;
      outline: none;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 13px;
    }
    .input-area textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .input-area textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .input-area button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; padding: 8px 12px; border-radius: 4px;
      cursor: pointer; font-size: 12px; font-weight: 500;
    }
    .input-area button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .status-indicator {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      padding: 4px 14px; font-style: italic; display: none;
    }
    .status-indicator::before {
      content: ''; display: inline-block; width: 9px; height: 9px; margin-right: 7px;
      border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent;
      border-radius: 50%; animation: agent-spin .75s linear infinite; vertical-align: -1px;
    }
    @keyframes agent-spin { to { transform: rotate(360deg); } }

    /* Diff block styles */
    /* Live agent timeline. Colours come from VS Code theme variables so the panel
       matches whatever theme the user has, light or dark. */
    .agent-panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin: 8px 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .agent-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px;
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .agent-panel-title { font-weight: 600; }
    .agent-panel-turn { opacity: 0.65; }
    .agent-panel-body { padding: 6px 10px; }
    .agent-row {
      padding: 3px 0;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .agent-text { color: var(--vscode-foreground); }
    .agent-thinking { color: var(--vscode-descriptionForeground); font-style: italic; }
    .agent-tool { font-family: var(--vscode-editor-font-family); font-size: 11px; }
    .agent-tool-running { color: var(--vscode-descriptionForeground); }
    .agent-tool-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    .agent-tool-error { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
    .agent-approval {
      color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-charts-yellow));
      font-weight: 500;
    }
    .agent-finished {
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 4px;
      padding-top: 6px;
    }
    .agent-error { color: var(--vscode-errorForeground); }

    .diff-container {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px; margin: 8px 0; overflow: hidden;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
    }
    .diff-header {
      padding: 4px 10px;
      display: flex; justify-content: space-between; align-items: center;
      background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .diff-filepath {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
    }
    .diff-actions { display: flex; gap: 4px; }
    .diff-btn {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      padding: 2px 8px; border-radius: 3px;
      cursor: pointer; font-size: 10px;
      font-family: var(--vscode-font-family, sans-serif);
    }
    .diff-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .diff-btn.apply {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
    }
    .diff-btn.apply:hover { background: var(--vscode-button-hoverBackground); }
    .diff-body { padding: 0; }
    .diff-line {
      padding: 0 8px; white-space: pre-wrap; line-height: 1.5;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
    }
    .diff-line-remove {
      background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.15));
    }
    .diff-line-add {
      background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.12));
    }

    /* Code block with filepath (for new files) */
    .code-block-container {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px; margin: 8px 0; overflow: hidden;
    }
    .code-block-header {
      padding: 4px 10px;
      display: flex; justify-content: space-between; align-items: center;
      background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .code-block-filepath {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
    }
    .code-block-actions { display: flex; gap: 4px; }
    .code-block-container pre {
      margin: 0 !important; border: none !important;
      border-radius: 0 !important; background: transparent !important;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <span class="header-title">Repo Intelligence</span>
      <div id="projectBadge"></div>
    </div>
    <button class="icon-btn" id="newSessionBtn">+ New</button>
  </header>

  <div class="main-container">
    <div class="sessions-bar">
      <select id="sessionsSelect"></select>
      <button class="delete-btn" id="deleteSessionBtn">✕</button>
    </div>
    <select class="agent-mode" id="agentMode" title="Choose how the agent handles this request">
      <option value="implement" selected>Implement — prepare a reviewed change set</option>
      <option value="plan">Plan — inspect and propose an implementation plan</option>
      <option value="explain">Explain — answer using repository context</option>
    </select>

    <div class="chat-area" id="chatArea"></div>

    <div class="context-pill" id="contextPill"></div>
    <div class="status-indicator" id="statusIndicator"></div>

    <div class="input-area">
      <textarea id="userInput" placeholder="Ask about your codebase..."></textarea>
      <button id="sendBtn">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    let vscode;
    let chatArea;
    let userInput;
    let sendBtn;
    let newSessionBtn;
    let deleteSessionBtn;
    let sessionsSelect;
    let statusIndicator;
    let contextPill;
    let agentMode;
    let currentStreamBubble = null;

    // Chat suggestions are read-only. Applying a change goes through the agent, which
    // gates every write behind an explicit approval with a staleness check -- the chat
    // pane must not offer a second, unchecked way to write to disk.

    try {
      console.log('[RepoIntel] 1/7 Script started');
      vscode = acquireVsCodeApi();
      console.log('[RepoIntel] 2/7 acquireVsCodeApi OK');

      chatArea = document.getElementById('chatArea');
      userInput = document.getElementById('userInput');
      sendBtn = document.getElementById('sendBtn');
      newSessionBtn = document.getElementById('newSessionBtn');
      deleteSessionBtn = document.getElementById('deleteSessionBtn');
      sessionsSelect = document.getElementById('sessionsSelect');
      statusIndicator = document.getElementById('statusIndicator');
      contextPill = document.getElementById('contextPill');
      agentMode = document.getElementById('agentMode');

      console.log('[RepoIntel] 3/7 DOM refs:', {
        chatArea: !!chatArea, userInput: !!userInput, sendBtn: !!sendBtn,
        newSessionBtn: !!newSessionBtn, deleteSessionBtn: !!deleteSessionBtn,
        sessionsSelect: !!sessionsSelect, statusIndicator: !!statusIndicator, contextPill: !!contextPill
      });

    vscode.postMessage({ type: 'ready' });
    console.log('[RepoIntel] 4/7 Sent ready message');

    // Handle autosizing textarea
    if (userInput) {
      userInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight - 20) + 'px';
      });
    }
    console.log('[RepoIntel] 5/7 userInput listener OK');

    if (sendBtn) {
      sendBtn.addEventListener('click', function() {
        console.log('[RepoIntel] Send button CLICKED');
        sendMessage();
      });
    }
    if (userInput) {
      userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          console.log('[RepoIntel] Enter key pressed');
          sendMessage();
        }
      });
    }
    console.log('[RepoIntel] 6/7 sendBtn + keydown listeners OK');

    if (newSessionBtn) {
      newSessionBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'newSession' });
      });
    }

    if (deleteSessionBtn) {
      deleteSessionBtn.addEventListener('click', () => {
        const sessionId = sessionsSelect ? sessionsSelect.value : null;
        if (sessionId) {
          vscode.postMessage({ type: 'deleteSession', sessionId });
        }
      });
    }

    if (sessionsSelect) {
      sessionsSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'selectSession', sessionId: sessionsSelect.value });
      });
    }

    console.log('[RepoIntel] 7/7 ALL listeners registered successfully');
    } catch (initErr) {
      console.error('[RepoIntel] INIT CRASHED:', initErr);
    }

    function sendMessage() {
      try {
        console.log('[RepoIntel] sendMessage() called');
        const text = userInput.value.trim();
        console.log('[RepoIntel] text value:', JSON.stringify(text));
        if (!text) { console.log('[RepoIntel] text is empty, returning'); return; }

        // Add user bubble
        appendBubble('user', text);
        userInput.value = '';
        userInput.style.height = 'auto';
        userInput.disabled = true;
        sendBtn.disabled = true;
        sendBtn.textContent = 'Working…';

        console.log('[RepoIntel] posting agent request to extension');
        vscode.postMessage({ type: 'sendAgentMessage', text, mode: agentMode ? agentMode.value : 'implement' });
      } catch (err) {
        console.error('[RepoIntel] sendMessage FAILED:', err);
      }
    }

    function appendBubble(role, content) {
      try {
        const div = document.createElement('div');
        div.className = 'msg ' + role;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'msg-content';
        contentDiv.setAttribute('data-raw', content);
        
        // Simple code formatter formatting
        contentDiv.innerHTML = formatMarkdown(content);
        
        div.appendChild(contentDiv);
        chatArea.appendChild(div);
        chatArea.scrollTop = chatArea.scrollHeight;
        return div;
      } catch (err) {
        console.error('appendBubble failed:', err);
        return null;
      }
    }

    function formatMarkdown(text) {
      if (!text || typeof text !== 'string') return '';

      // 1. Parse SEARCH/REPLACE blocks BEFORE escaping HTML
      let processed = text;
      const diffRegex = /^([^\\n]+)\\n<<<<<<< SEARCH\\n([\\s\\S]*?)\\n=======\\s*\\n([\\s\\S]*?)\\n>>>>>>> REPLACE/gm;
      const diffBlocks = [];
      let diffMatch;
      while ((diffMatch = diffRegex.exec(text)) !== null) {
        diffBlocks.push({
          fullMatch: diffMatch[0],
          filepath: diffMatch[1].trim(),
          search: diffMatch[2],
          replace: diffMatch[3],
        });
      }

      // Replace each diff block with a placeholder
      for (let i = 0; i < diffBlocks.length; i++) {
        const block = diffBlocks[i];
        // Build inline diff HTML
        let diffHtml = '<div class="diff-container">' +
          '<div class="diff-header">' +
            '<span class="diff-filepath">' + block.filepath + '</span>' +
          '</div>' +
          '<div class="diff-body">';

        // Red lines (removed)
        block.search.split('\\n').forEach(function(line) {
          const escaped = line.replace(/&/g,'&amp;').replace(/[\\x3c]/g,'&lt;').replace(/[\\x3e]/g,'&gt;');
          diffHtml += '<div class="diff-line diff-line-remove">- ' + escaped + '</div>';
        });
        // Green lines (added)
        block.replace.split('\\n').forEach(function(line) {
          const escaped = line.replace(/&/g,'&amp;').replace(/[\\x3c]/g,'&lt;').replace(/[\\x3e]/g,'&gt;');
          diffHtml += '<div class="diff-line diff-line-add">+ ' + escaped + '</div>';
        });

        diffHtml += '</div></div>';
        processed = processed.replace(block.fullMatch, '%%DIFF_BLOCK_' + i + '%%');
        diffBlocks[i].html = diffHtml;
      }

      // 2. Now escape HTML on the remaining text
      let html = processed
        .replace(/&/g, '&amp;')
        .replace(/[\\x3c]/g, '&lt;')
        .replace(/[\\x3e]/g, '&gt;');

      // 3. Restore diff block HTML (they were already escaped internally)
      for (let i = 0; i < diffBlocks.length; i++) {
        html = html.replace('%%DIFF_BLOCK_' + i + '%%', diffBlocks[i].html);
      }

      // 4. Code blocks with optional lang:filepath (for new files)
      html = html.replace(/[\\x60][\\x60][\\x60]([a-zA-Z0-9_+-]*(?::[a-zA-Z0-9_+\\-\\.\\/\\\\]+)?)\\n([\\s\\S]*?)[\\x60][\\x60][\\x60]/g, (match, info, code) => {
        let lang = info;
        let filepath = '';
        if (info.includes(':')) {
          const parts = info.split(':');
          lang = parts[0];
          filepath = parts[1];
        }
        if (filepath) {
          return '<div class="code-block-container">' +
            '<div class="code-block-header">' +
              '<span class="code-block-filepath">' + filepath + '</span>' +
            '</div>' +
            '<pre><code class="' + lang + '">' + code + '</code></pre>' +
          '</div>';
        }
        return '<pre><code class="' + lang + '">' + code + '</code></pre>';
      });

      // 5. Inline markdown
      html = html.replace(/[\\x60]([^\\x60\\n]+)[\\x60]/g, '<code>$1</code>');
      html = html.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/^(?:###|\\s*###)\\s+(.*?)(?=\\n|$)/gm, '<h3>$1</h3>');
      html = html.replace(/^(?:##|\\s*##)\\s+(.*?)(?=\\n|$)/gm, '<h2>$1</h2>');
      html = html.replace(/^(?:#|\\s*#)\\s+(.*?)(?=\\n|$)/gm, '<h1>$1</h1>');
      html = html.replace(/(?:^|\\n)\\s*[\\*\\-]\\s+(.*?)(?=\\n|$)/g, '\\n<li>$1</li>');
      html = html.replace(/(?:\\n?<li>.*?<\\/li>)+/g, (match) => {
        return '\\n<ul>' + match.trim() + '\\n</ul>';
      });
      html = html.replace(/\\n/g, '<br>');
      return html;
    }


    // ── Live agent timeline ────────────────────────────────────
    // Steps arrive pre-batched from the extension host (~50ms windows), so this only
    // needs to append; it never sees individual tokens.
    let agentPanel = null;
    let agentRunId = null;
    const agentToolRows = {};

    function ensureAgentPanel(runId) {
      if (agentPanel && agentRunId === runId) return agentPanel;
      agentRunId = runId;
      for (const key of Object.keys(agentToolRows)) delete agentToolRows[key];

      const wrapper = document.createElement('div');
      wrapper.className = 'agent-panel';
      wrapper.innerHTML = '<div class="agent-panel-header">'
        + '<span class="agent-panel-title">Agent</span>'
        + '<span class="agent-panel-turn"></span>'
        + '</div><div class="agent-panel-body"></div>';
      chatArea.appendChild(wrapper);
      agentPanel = wrapper;
      return wrapper;
    }

    function agentRow(className, text) {
      const row = document.createElement('div');
      row.className = 'agent-row ' + className;
      row.textContent = text;
      return row;
    }

    function renderAgentStream(data) {
      const panel = ensureAgentPanel(data.runId);
      const body = panel.querySelector('.agent-panel-body');
      const turnLabel = panel.querySelector('.agent-panel-turn');

      for (const step of data.steps) {
        if (step.kind === 'turn') {
          turnLabel.textContent = 'turn ' + step.turn + '/' + step.maxTurns;
        } else if (step.kind === 'text') {
          // Consecutive text merges into the same paragraph so streaming reads naturally.
          const last = body.lastElementChild;
          if (last && last.classList.contains('agent-text')) last.textContent += step.text;
          else body.appendChild(agentRow('agent-text', step.text));
        } else if (step.kind === 'thinking') {
          const last = body.lastElementChild;
          if (last && last.classList.contains('agent-thinking')) last.textContent += step.text;
          else body.appendChild(agentRow('agent-thinking', step.text));
        } else if (step.kind === 'tool') {
          let row = agentToolRows[step.toolCallId];
          if (!row) {
            row = agentRow('agent-tool', '');
            agentToolRows[step.toolCallId] = row;
            body.appendChild(row);
          }
          const icon = step.status === 'running' ? '\u25CB' : step.status === 'ok' ? '\u2713' : '\u2717';
          row.className = 'agent-row agent-tool agent-tool-' + step.status;
          row.textContent = icon + ' ' + step.name + (step.preview ? ' \u2014 ' + step.preview : '');
        } else if (step.kind === 'approval') {
          const count = step.changeSetIds.length + step.commandIds.length;
          body.appendChild(agentRow('agent-approval',
            '\u23F8 Waiting for your approval on ' + count + ' proposed action' + (count === 1 ? '' : 's') +
            ' \u2014 run "Repo Intelligence: Approve Pending Change Set"'));
        } else if (step.kind === 'finished') {
          const cache = step.usage.cacheReadTokens ? ', ' + step.usage.cacheReadTokens + ' cached' : '';
          body.appendChild(agentRow('agent-finished',
            step.status + ' after ' + step.turns + ' turn' + (step.turns === 1 ? '' : 's') +
            ' (' + step.usage.inputTokens + ' in, ' + step.usage.outputTokens + ' out' + cache + ')'));
          agentPanel = null;
        } else if (step.kind === 'error') {
          body.appendChild(agentRow('agent-error', '\u26A0 ' + step.message));
          agentPanel = null;
        }
      }

      chatArea.scrollTop = chatArea.scrollHeight;
    }

    window.addEventListener('message', event => {
      const data = event.data;
      switch (data.type) {
        case 'sessions':
          sessionsSelect.innerHTML = '';
          data.sessions.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.title;
            if (s.id === data.activeSessionId) {
              opt.selected = true;
            }
            sessionsSelect.appendChild(opt);
          });
          break;

        case 'projectInfo':
          const badge = document.getElementById('projectBadge');
          if (badge) {
            badge.textContent = data.name + ' (' + data.framework + ')';
            badge.style.display = 'block';
          }
          break;

        case 'messages':
          chatArea.innerHTML = '';
          currentStreamBubble = null;
          data.messages.forEach(m => {
            appendBubble(m.role, m.content);
          });
          break;

        case 'status':
          if (data.status === 'thinking') {
            statusIndicator.style.display = 'block';
            statusIndicator.textContent = data.message || 'Understanding your request…';
          } else if (data.status === 'retrieving-context') {
            statusIndicator.style.display = 'block';
            statusIndicator.textContent = data.message || 'Finding the relevant files and project conventions…';
          } else if (data.status === 'generating') {
            statusIndicator.style.display = 'block';
            statusIndicator.textContent = data.message || 'Preparing a context-aware response…';
          } else if (data.status === 'idle') {
            statusIndicator.style.display = 'none';
            currentStreamBubble = null;
            userInput.disabled = false;
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
          } else if (data.status === 'no-project') {
            statusIndicator.style.display = 'block';
            statusIndicator.textContent = 'No repository scanned. Please scan the workspace first.';
          }
          break;

        case 'contextInfo':
          contextPill.style.display = 'block';
          contextPill.textContent = 'Context: ' + data.files.length + ' files (~' + Math.round(data.tokensUsed) + ' tokens)';
          contextPill.title = 'Files included:\\n' + data.files.join('\\n');
          break;

        case 'streamChunk':
          if (!currentStreamBubble) {
            currentStreamBubble = appendBubble('assistant', '');
          }
          const textDiv = currentStreamBubble.querySelector('.msg-content');
          // Add chunk and reformat
          const rawText = textDiv.getAttribute('data-raw') || '';
          const newRaw = rawText + data.chunk;
          textDiv.setAttribute('data-raw', newRaw);
          textDiv.innerHTML = formatMarkdown(newRaw);
          chatArea.scrollTop = chatArea.scrollHeight;
          break;

        case 'agentTimeline':
          appendBubble('assistant', data.content);
          chatArea.scrollTop = chatArea.scrollHeight;
          break;

        case 'agentStream':
          renderAgentStream(data);
          break;

        case 'error':
          appendBubble('assistant', '⚠️ Error: ' + data.message);
          userInput.disabled = false;
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send';
          break;
      }
    });
  </script>
</body>
</html>`;
  }


  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
