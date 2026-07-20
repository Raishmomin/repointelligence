// ═══════════════════════════════════════════════════════════════
// Knowledge Tree Provider — Sidebar Explorer tree view
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { EventBus } from '../../shared/EventBus';

export class KnowledgeTreeProvider implements vscode.TreeDataProvider<KnowledgeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<KnowledgeItem | undefined | null | void> =
    new vscode.EventEmitter<KnowledgeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<KnowledgeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private eventBus = EventBus.getInstance();
  private container = ServiceContainer.getInstance();
  private activeProjectId: string | null = null;

  constructor() {
    this.eventBus.on('scan:completed', (result) => {
      this.activeProjectId = result.projectId;
      this.refresh();
    });

    this.eventBus.on('file:changed', () => {
      this.refresh();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: KnowledgeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: KnowledgeItem): Promise<KnowledgeItem[]> {
    if (!this.activeProjectId) {
      // Find latest scanned project if none is active
      const latestProject = this.container.database.queryOne<{ id: string }>(
        'SELECT id FROM projects ORDER BY last_scan DESC LIMIT 1'
      );
      if (latestProject) {
        this.activeProjectId = latestProject.id;
      } else {
        return [new KnowledgeItem('No repository scanned yet', vscode.TreeItemCollapsibleState.None)];
      }
    }

    if (!element) {
      // Top-level categories
      const categories = this.container.database.query<{ category: string; count: number }>(
        `SELECT category, COUNT(*) as count FROM files 
         WHERE project_id = ? AND category != 'style'
         GROUP BY category ORDER BY count DESC`,
        [this.activeProjectId]
      );

      return categories.map(
        c => {
          const label = c.category === 'unknown' ? 'OTHER' : c.category.toUpperCase();
          return new KnowledgeItem(
            `${label} (${c.count})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'category',
            c.category
          );
        }
      );
    }

    if (element.contextValue === 'category') {
      const category = element.data as string;
      const files = this.container.fileRepository.getByCategory(this.activeProjectId!, category);
      return files.map(
        f => new KnowledgeItem(
          f.relative_path,
          vscode.TreeItemCollapsibleState.Collapsed,
          'file',
          f.id,
          {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [vscode.Uri.file(f.path)],
          }
        )
      );
    }

    if (element.contextValue === 'file') {
      const fileId = element.data as string;
      const symbols = this.container.symbolRepository.getByFile(fileId);
      if (symbols.length === 0) {
        return [new KnowledgeItem('No symbols extracted', vscode.TreeItemCollapsibleState.None)];
      }
      return symbols.map(
        s => new KnowledgeItem(
          `[${s.kind}] ${s.name}`,
          vscode.TreeItemCollapsibleState.None,
          'symbol',
          s,
          element.command ? undefined : {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [
              vscode.Uri.file(
                this.container.database.queryOne<{ path: string }>('SELECT path FROM files WHERE id = ?', [fileId])?.path ?? ''
              ),
              {
                selection: new vscode.Range(
                  new vscode.Position(s.start_line - 1, 0),
                  new vscode.Position(s.end_line - 1, 0)
                ),
              },
            ],
          }
        )
      );
    }

    return [];
  }
}

class KnowledgeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue?: string,
    public readonly data?: any,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
    this.tooltip = label;
    if (contextValue === 'category') {
      this.iconPath = new vscode.ThemeIcon('folder');
    } else if (contextValue === 'file') {
      this.iconPath = new vscode.ThemeIcon('file-code');
    } else if (contextValue === 'symbol') {
      this.iconPath = new vscode.ThemeIcon('symbol-field');
    }
  }
}
