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
import { ProposalContentProvider, PROPOSAL_SCHEME } from './vscode/providers/ProposalContentProvider';
import { ProviderStatusBar } from './vscode/providers/ProviderStatusBar';
import { migrateLegacyProviderConfig } from './layer3-reasoning/providers/migrateLegacyConfig';
import { Logger } from './shared/Logger';
import { EXTENSION_NAME } from './shared/constants';

let statusBar: StatusBarManager;
let fileWatcher: FileWatcherManager;
let knowledgeTreeProvider: KnowledgeTreeProvider;
let chatWebviewProvider: ChatWebviewProvider;
let providerStatusBar: ProviderStatusBar;

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
  // Unsubscribes the agent stream bridge from the EventBus on shutdown.
  context.subscriptions.push({ dispose: () => chatWebviewProvider.dispose() });

  // 7. Serve proposed file contents to the diff viewer from memory, so reviewing an
  //    agent change never writes a temp file to disk.
  const proposalProvider = new ProposalContentProvider(container.database);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposalProvider),
    proposalProvider,
  );

  // 8. Carry pre-registry provider settings across, so the setup flow opens pre-filled
  //    rather than showing defaults over the top of the user's existing choices.
  const providerFactory = container.providerFactory;
  await migrateLegacyProviderConfig(context, providerFactory.getRegistry(), providerFactory.getStore());

  // 9. Show which backend is actually serving runs — a fallback can change it silently.
  providerStatusBar = new ProviderStatusBar(providerFactory);
  context.subscriptions.push({ dispose: () => providerStatusBar.dispose() });

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
