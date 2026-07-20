// ═══════════════════════════════════════════════════════════════
// Command Registration — Central command registry
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { COMMANDS } from '../../shared/constants';
import { scanRepository } from './scanRepository';
import { clearApiKey, setApiKey } from './manageApiKey';
import { chooseModelProvider } from './chooseModelProvider';

import { ServiceContainer } from '../../container';

/**
 * Register all extension commands.
 * Commands are defined in package.json contributes.commands
 * and wired to handlers here.
 */
export function registerCommands(context: vscode.ExtensionContext): void {
  const container = ServiceContainer.getInstance();

  // Scan Repository
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.SCAN_REPOSITORY, scanRepository),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.CHOOSE_MODEL_PROVIDER, () => chooseModelProvider()),
    vscode.commands.registerCommand(COMMANDS.SET_API_KEY, () => setApiKey()),
    vscode.commands.registerCommand(COMMANDS.CLEAR_API_KEY, () => clearApiKey()),
  );

  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.START_AGENT, async () => {
    const mode = await vscode.window.showQuickPick([{ label: 'Explain', value: 'explain' }, { label: 'Plan', value: 'plan' }, { label: 'Implement', value: 'implement' }], { placeHolder: 'Choose agent task mode' });
    if (!mode) return;
    const folders = vscode.workspace.workspaceFolders ?? []; if (!folders.length) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(folders.map(item => ({ label: item.name, folder: item })), { placeHolder: 'Choose target workspace folder' }).then(item => item?.folder);
    if (!folder) return;
    const prompt = await vscode.window.showInputBox({ prompt: `${mode.label}: what should the agent do?` }); if (!prompt) return;
    const run = await container.agentService.run(prompt, mode.value as any, folder);
    container.chatWebviewProvider.showAgentRun(run, container.agentService.getPendingChangeSets(), container.agentService.getPendingCommands());
    if (run.status === 'awaiting_approval') vscode.window.showInformationMessage('Agent prepared actions for review. Use “Repo Intelligence: Review Pending Change Set”.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.REVIEW_CHANGE_SET, async () => {
    const pending = container.agentService.getPendingChangeSets(); const item = await vscode.window.showQuickPick(pending.map(change => ({ label: change.summary, description: `${change.operations.length} file operation(s)`, change })), { placeHolder: 'Review pending agent changes' }); if (!item) return;
    const first = item.change.operations[0]; if (first) await container.chatWebviewProvider.showAgentDiff(item.change.id, first.path);
  }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.APPROVE_CHANGE_SET, async () => { const id = await pickPendingChangeSet(container, 'Approve'); if (id) { await container.agentService.approveChangeSet(id); vscode.window.showInformationMessage('Agent change set applied.'); } }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.REJECT_CHANGE_SET, async () => { const id = await pickPendingChangeSet(container, 'Reject'); if (id) { await container.agentService.rejectChangeSet(id); vscode.window.showInformationMessage('Agent change set rejected.'); } }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.APPROVE_COMMAND, async () => { const commands = container.agentService.getPendingCommands(); const choice = await vscode.window.showQuickPick(commands.map(command => ({ label: `${command.command} ${command.args.join(' ')}`, description: command.reason, command })), { placeHolder: 'Every command requires approval' }); if (!choice) return; try { const output = await container.agentService.approveCommand(choice.command.id); container.chatWebviewProvider.showAgentLog(output); } catch (error) { container.chatWebviewProvider.showAgentLog(error instanceof Error ? error.message : String(error)); } }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.REJECT_COMMAND, async () => { const commands = container.agentService.getPendingCommands(); const choice = await vscode.window.showQuickPick(commands.map(command => ({ label: `${command.command} ${command.args.join(' ')}`, command }))); if (choice) await container.agentService.rejectCommand(choice.command.id); }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.REVERT_CHANGE_SET, async () => { const records = container.database.query<{ id: string; summary: string }>('SELECT id, summary FROM change_sets WHERE status = ? ORDER BY applied_at DESC', ['applied']); const choice = await vscode.window.showQuickPick(records.map(record => ({ label: record.summary, record }))); if (choice) await container.changeSetService.revert(choice.record.id); }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.SHOW_AGENT_HISTORY, () => {
    const runs = container.database.query<{ mode: string; prompt: string; status: string; created_at: number }>('SELECT mode, prompt, status, created_at FROM agent_runs ORDER BY created_at DESC LIMIT 20');
    container.chatWebviewProvider.showAgentLog(runs.map(run => `[${new Date(run.created_at).toLocaleString()}] ${run.mode} · ${run.status}\n${run.prompt}`).join('\n\n') || 'No agent runs yet.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.REVOKE_SESSION_TRUST, () => { container.agentService.revokeSessionTrust(); vscode.window.showInformationMessage('Agent session trust revoked.'); }));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.CANCEL_AGENT, () => {
    const running = container.agentService.getRunningRunIds();
    if (!running.length) { vscode.window.showInformationMessage('No agent run is in progress.'); return; }
    running.forEach(id => container.agentService.cancel(id));
    vscode.window.showInformationMessage('Stopping the agent run.');
  }));

  // Open Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.OPEN_CHAT, () => {
      vscode.commands.executeCommand('repo-intelligence.chatView.focus');
    }),
  );

  // Generate Code
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.GENERATE_CODE, async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'Enter instructions for code generation',
        placeHolder: 'e.g., Create a React hook to fetch user profiles...',
      });
      if (prompt) {
        container.chatWebviewProvider.handleProgrammaticPrompt(`Generate code based on this instruction: ${prompt}`);
      }
    }),
  );

  // Review Code
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.REVIEW_CODE, () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Open a code file and select some code to review.');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      if (!selectedText) {
        vscode.window.showWarningMessage('Select a block of code to review.');
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
      const prompt = `Review the following code from \`${relativePath}\`:\n\n\`\`\`typescript\n${selectedText}\n\`\`\`\n\nAnalyze for bugs, edge cases, and compliance with project conventions.`;
      
      container.chatWebviewProvider.handleProgrammaticPrompt(prompt);
    }),
  );

  // Show Knowledge Base
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.SHOW_KNOWLEDGE, () => {
      vscode.commands.executeCommand('repo-intelligence.knowledgeView.focus');
    }),
  );
}

async function pickPendingChangeSet(container: ServiceContainer, action: string): Promise<string | undefined> { const item = await vscode.window.showQuickPick(container.agentService.getPendingChangeSets().map(change => ({ label: `${action}: ${change.summary}`, description: change.operations.map(op => `${op.kind} ${op.path}`).join(', '), change }))); return item?.change.id; }
