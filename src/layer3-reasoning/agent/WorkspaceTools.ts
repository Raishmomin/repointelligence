import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { FileOperation, ToolCall, ToolResult } from '../../shared/types/agent.types';
import { classifyFileRisk, contentHash } from './AgentSafety';
import { resolveAgentPath } from './pathGuard';

export class WorkspaceTools {
  constructor(private readonly workspace: vscode.WorkspaceFolder) {}
  private get root(): string { return this.workspace.uri.fsPath; }

  resolve(relativePath: string): string {
    const ignored = vscode.workspace.getConfiguration('repo-intelligence').get<string[]>('agent.ignorePatterns', []);
    return resolveAgentPath(this.root, relativePath, ignored);
  }
  async readFile(relativePath: string): Promise<string> { return fs.readFile(this.resolve(relativePath), 'utf8'); }
  async searchFiles(query: string): Promise<string> {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.workspace, `**/*${query}*`), '**/{node_modules,.git,out,dist}/**', 30);
    return files.map(uri => vscode.workspace.asRelativePath(uri, false)).join('\n');
  }
  async queryIndex(query: string): Promise<string> {
    const project = ServiceContainer.getInstance().database.queryOne<{ id: string }>('SELECT id FROM projects WHERE root_path = ?', [this.root]);
    if (!project) return 'Workspace has not been indexed.';
    // Styling requests such as "update footer" should not wait for a separate Ollama
    // embedding request before the actual model response starts.
    const result = await ServiceContainer.getInstance().hybridSearchEngine.search(project.id, query, 4, { enableSemantic: false });
    const maxChars = vscode.workspace.getConfiguration('repo-intelligence').get<number>('agent.initialContextMaxChars', 8000);
    let remaining = maxChars;
    const sections: string[] = [];
    for (const item of result) {
      if (remaining <= 0) break;
      const prefix = `${path.relative(this.root, item.filePath)}\n`;
      const content = item.content.slice(0, Math.max(0, remaining - prefix.length));
      sections.push(prefix + content);
      remaining -= prefix.length + content.length;
    }
    return sections.join('\n\n');
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      if (call.name === 'read_file') return { toolCallId: call.id, ok: true, content: await this.readFile(String(call.arguments.path ?? '')) };
      if (call.name === 'search_files') return { toolCallId: call.id, ok: true, content: await this.searchFiles(String(call.arguments.query ?? '')) };
      if (call.name === 'query_index') return { toolCallId: call.id, ok: true, content: await this.queryIndex(String(call.arguments.query ?? '')) };
      return { toolCallId: call.id, ok: true, content: 'Proposal received. Continue with a final response.' };
    } catch (error) { return { toolCallId: call.id, ok: false, content: error instanceof Error ? error.message : String(error) }; }
  }
  async makeOperation(value: Record<string, unknown>): Promise<FileOperation> {
    const kind = String(value.kind) as FileOperation['kind'];
    const relativePath = String(value.path ?? ''); const abs = this.resolve(relativePath);
    const exists = await fs.stat(abs).then(() => true).catch(() => false);
    const beforeContent = exists ? await fs.readFile(abs, 'utf8') : undefined;
    return { id: randomUUID(), kind, path: relativePath, newPath: typeof value.newPath === 'string' ? value.newPath : undefined,
      content: typeof value.content === 'string' ? value.content : undefined, beforeContent,
      baseHash: beforeContent === undefined ? undefined : contentHash(beforeContent), risk: classifyFileRisk(kind, relativePath), reason: typeof value.reason === 'string' ? value.reason : undefined };
  }
}
