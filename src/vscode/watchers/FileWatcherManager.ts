// ═══════════════════════════════════════════════════════════════
// File Watcher Manager — Debounced file system change detection
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { EventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { DEFAULTS } from '../../shared/constants';

export class FileWatcherManager {
  private watcher: vscode.FileSystemWatcher | null = null;
  private eventBus = EventBus.getInstance();
  private logger = Logger.getInstance();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Start watching for file changes in the workspace. */
  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{ts,tsx,js,jsx,json}',
    );

    this.watcher.onDidCreate(uri => this.debounceEmit('file:created', uri));
    this.watcher.onDidChange(uri => this.debounceEmit('file:changed', uri));
    this.watcher.onDidDelete(uri => this.debounceEmit('file:deleted', uri));

    this.logger.info('File watcher started');
  }

  private debounceEmit(event: 'file:created' | 'file:changed' | 'file:deleted', uri: vscode.Uri): void {
    const key = `${event}:${uri.fsPath}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.eventBus.emit(event, { path: uri.fsPath });
      this.logger.debug(`File ${event.split(':')[1]}`, { path: uri.fsPath });
    }, DEFAULTS.FILE_WATCHER_DEBOUNCE_MS));
  }

  dispose(): void {
    this.watcher?.dispose();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }
}
