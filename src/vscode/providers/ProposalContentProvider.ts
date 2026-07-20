import * as vscode from 'vscode';
import { DatabaseManager } from '../../layer2-context/database/DatabaseManager';
import { FileOperation } from '../../shared/types/agent.types';

export const PROPOSAL_SCHEME = 'repo-intelligence-proposal';

/**
 * Serves proposed file contents to VS Code's diff viewer as read-only virtual documents.
 *
 * The alternative — writing the proposal to a temp file under globalStorage — leaves a
 * file on disk per reviewed change with nothing responsible for cleaning it up, and puts
 * a second writer next to the one code path allowed to touch files. A virtual document
 * has neither problem: nothing is ever written, and the content disappears with the tab.
 *
 * URI shape: `repo-intelligence-proposal:/<relativePath>?changeSet=<id>`
 * The path is carried in the URI so the diff tab is titled with the real filename and
 * syntax highlighting matches the file extension.
 */
export class ProposalContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly database: DatabaseManager) {}

  static uriFor(changeSetId: string, relativePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: PROPOSAL_SCHEME,
      path: `/${relativePath}`,
      query: `changeSet=${encodeURIComponent(changeSetId)}`,
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const changeSetId = decodeURIComponent(
      new URLSearchParams(uri.query).get('changeSet') ?? '',
    );
    const relativePath = uri.path.replace(/^\//, '');

    const stored = this.database.queryOne<{ operations_json: string }>(
      'SELECT operations_json FROM change_sets WHERE id = ?',
      [changeSetId],
    );
    if (!stored) return '// This change set no longer exists.';

    const operations = JSON.parse(stored.operations_json) as FileOperation[];
    const operation = operations.find((item) => item.path === relativePath);
    if (!operation) return `// No proposed change for ${relativePath}.`;

    // A deletion diffs against empty, which renders as every line removed.
    if (operation.kind === 'delete') return '';
    return operation.content ?? '';
  }

  /** Refreshes an open diff after the underlying change set is modified. */
  refresh(changeSetId: string, relativePath: string): void {
    this.changed.fire(ProposalContentProvider.uriFor(changeSetId, relativePath));
  }

  dispose(): void {
    this.changed.dispose();
  }
}
