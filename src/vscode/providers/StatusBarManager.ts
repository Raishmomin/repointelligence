// ═══════════════════════════════════════════════════════════════
// Status Bar Manager — Real-time scan progress & project info
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { EventBus } from '../../shared/EventBus';
import { EXTENSION_ID, COMMANDS } from '../../shared/constants';

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private eventBus = EventBus.getInstance();
  private disposables: (() => void)[] = [];

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left, 100,
    );
    this.statusBarItem.command = COMMANDS.SHOW_KNOWLEDGE;
    this.setIdle();
    this.statusBarItem.show();
    this.subscribeToEvents();
  }

  private subscribeToEvents(): void {
    this.disposables.push(
      this.eventBus.on('scan:started', () => {
        this.statusBarItem.text = '$(sync~spin) Scanning...';
        this.statusBarItem.tooltip = 'Repository Intelligence: Scanning repository';
      }),
      this.eventBus.on('scan:progress', ({ message }) => {
        this.statusBarItem.text = `$(sync~spin) ${message}`;
      }),
      this.eventBus.on('scan:completed', ({ stats, duration }) => {
        this.statusBarItem.text = `$(database) ${stats.totalFiles} files indexed`;
        this.statusBarItem.tooltip = `Repository Intelligence\n${stats.totalFiles} files | ${(duration / 1000).toFixed(1)}s`;
      }),
      this.eventBus.on('scan:error', ({ error }) => {
        this.statusBarItem.text = '$(error) Scan failed';
        this.statusBarItem.tooltip = `Error: ${error.message}`;
      }),
      this.eventBus.on('index:progress', ({ current, total }) => {
        this.statusBarItem.text = `$(sync~spin) Indexing ${current}/${total}`;
      }),
    );
  }

  private setIdle(): void {
    this.statusBarItem.text = '$(hubot) Repo Intelligence';
    this.statusBarItem.tooltip = 'Click to show knowledge base';
  }

  dispose(): void {
    this.disposables.forEach(d => d());
    this.statusBarItem.dispose();
  }
}
