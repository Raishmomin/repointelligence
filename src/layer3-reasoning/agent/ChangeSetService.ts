import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { ChangeSet, FileOperation } from '../../shared/types/agent.types';
import { contentHash } from './AgentSafety';

export class ChangeSetService {
  constructor(private readonly container: ServiceContainer) {}
  async apply(change: ChangeSet): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === change.workspaceUri); if (!workspace) throw new Error('Selected workspace is no longer open.');
    for (const op of change.operations) await this.verify(workspace, op);
    const edit = new vscode.WorkspaceEdit();
    for (const op of change.operations) {
      const uri = vscode.Uri.joinPath(workspace.uri, op.path);
      if (op.kind === 'create') edit.createFile(uri, { ignoreIfExists: false });
      if (op.kind === 'create') edit.insert(uri, new vscode.Position(0, 0), op.content ?? '');
      if (op.kind === 'edit') { const doc = await vscode.workspace.openTextDocument(uri); edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), op.content ?? ''); }
      if (op.kind === 'delete') edit.deleteFile(uri, { ignoreIfNotExists: false });
      if (op.kind === 'rename' && op.newPath) edit.renameFile(uri, vscode.Uri.joinPath(workspace.uri, op.newPath), { overwrite: false });
    }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the change set.');
    change.status = 'applied'; const now = Date.now();
    this.container.database.transaction(() => { this.container.database.run('UPDATE change_sets SET status = ?, applied_at = ? WHERE id = ?', ['applied', now, change.id]); this.approval('change_set', change.id, true); }); this.container.database.save();
    vscode.commands.executeCommand('repo-intelligence.scanRepository');
  }
  reject(change: ChangeSet): void { change.status = 'rejected'; this.container.database.transaction(() => { this.container.database.run('UPDATE change_sets SET status = ? WHERE id = ?', ['rejected', change.id]); this.approval('change_set', change.id, false); }); this.container.database.save(); }
  async revert(id: string): Promise<void> {
    const saved = this.container.database.queryOne<{ operations_json: string; workspace_uri: string }>('SELECT operations_json, workspace_uri FROM change_sets WHERE id = ? AND status = ?', [id, 'applied']); if (!saved) throw new Error('Applied change set not found.');
    const workspace = vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === saved.workspace_uri); if (!workspace) throw new Error('Workspace is not open.');
    const ops = JSON.parse(saved.operations_json) as FileOperation[]; const edit = new vscode.WorkspaceEdit();
    for (const op of [...ops].reverse()) { const uri = vscode.Uri.joinPath(workspace.uri, op.path); if (op.kind === 'create') edit.deleteFile(uri, { ignoreIfNotExists: true }); else if (op.kind === 'edit' && op.beforeContent !== undefined) { const doc = await vscode.workspace.openTextDocument(uri); edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), op.beforeContent); } else if (op.kind === 'delete' && op.beforeContent !== undefined) { edit.createFile(uri, { ignoreIfExists: true }); edit.insert(uri, new vscode.Position(0, 0), op.beforeContent); } else if (op.kind === 'rename' && op.newPath) edit.renameFile(vscode.Uri.joinPath(workspace.uri, op.newPath), uri, { overwrite: false }); }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the revert.'); this.container.database.run('UPDATE change_sets SET status = ? WHERE id = ?', ['reverted', id]); this.container.database.save();
  }
  private async verify(workspace: vscode.WorkspaceFolder, op: FileOperation): Promise<void> { const absolute = path.resolve(workspace.uri.fsPath, op.path); if (!absolute.startsWith(workspace.uri.fsPath + path.sep)) throw new Error('Operation path escapes workspace.'); if (op.baseHash) { const text = await fs.readFile(absolute, 'utf8').catch(() => undefined); if (text === undefined || contentHash(text) !== op.baseHash) throw new Error(`Refusing stale edit: ${op.path} changed after review.`); } }
  private approval(type: 'change_set', subjectId: string, approved: boolean): void { this.container.database.run('INSERT INTO agent_approvals (id, subject_type, subject_id, approved, created_at) VALUES (?, ?, ?, ?, ?)', [crypto.randomUUID(), type, subjectId, approved ? 1 : 0, Date.now()]); }
}
