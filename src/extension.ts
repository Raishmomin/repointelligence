// ═══════════════════════════════════════════════════════════════
// Extension Entry Point — Activation and lifecycle management
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { ServiceContainer } from './container';
import { registerCommands } from './vscode/commands/registerCommands';
import { StatusBarManager } from './vscode/providers/StatusBarManager';
import { FileWatcherManager } from './vscode/watchers/FileWatcherManager';
import { KnowledgeTreeProvider } from './vscode/providers/KnowledgeTreeProvider';
import { ChatWebviewProvider } from './vscode/providers/ChatWebviewProvider';
import { Logger } from './shared/Logger';
import { EXTENSION_NAME } from './shared/constants';

let statusBar: StatusBarManager;
let fileWatcher: FileWatcherManager;
let knowledgeTreeProvider: KnowledgeTreeProvider;
let chatWebviewProvider: ChatWebviewProvider;

/**
 * Extension activation.
 * Kept intentionally lean — all heavy work is deferred to commands
 * or triggered by user actions.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = Logger.getInstance();
  logger.info(`${EXTENSION_NAME} activating...`);

  // 1. Initialize service container
  const container = ServiceContainer.initialize(context);

  // 1.5. Initialize database
  try {
    await container.database.initialize();
  } catch (err) {
    logger.error('Failed to initialize database during activation', err);
  }

  // 2. Register commands
  registerCommands(context);

  // 3. Initialize status bar
  statusBar = new StatusBarManager();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  // 4. Start file watcher
  fileWatcher = new FileWatcherManager();
  fileWatcher.start();
  context.subscriptions.push({ dispose: () => fileWatcher.dispose() });

  // 5. Initialize tree view sidebar
  knowledgeTreeProvider = new KnowledgeTreeProvider();
  vscode.window.registerTreeDataProvider('repo-intelligence.knowledgeView', knowledgeTreeProvider);

  // 6. Initialize chat webview panel
  chatWebviewProvider = container.chatWebviewProvider;
  vscode.window.registerWebviewViewProvider('repo-intelligence.chatView', chatWebviewProvider);

  // 5. Auto-scan on open (if enabled)
  const config = vscode.workspace.getConfiguration('repo-intelligence');
  const autoScan = config.get<boolean>('scan.autoScanOnOpen', true);
  if (autoScan && vscode.workspace.workspaceFolders?.length) {
    // Defer auto-scan to avoid slowing down activation
    setTimeout(() => {
      vscode.commands.executeCommand('repo-intelligence.scanRepository');
    }, 3000);
  }

  logger.info(`${EXTENSION_NAME} activated successfully`);
}

/**
 * Extension deactivation — cleanup all resources.
 */
export async function deactivate(): Promise<void> {
  try {
    const container = ServiceContainer.getInstance();
    await container.dispose();
  } catch {
    // Container may not be initialized
  }
}
