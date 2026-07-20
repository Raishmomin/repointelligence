import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { CommandRequest } from '../../shared/types/agent.types';

export class CommandRunner {
  constructor(private readonly container: ServiceContainer) {}
  run(request: CommandRequest): Promise<string> {
    request.status = 'running'; this.update(request);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timeout = vscode.workspace.getConfiguration('repo-intelligence').get<number>('agent.commandTimeoutMs', 120000);
      const process = childProcess.spawn(request.command, request.args, { cwd: request.cwd, shell: false, windowsHide: true }); let output = ''; let killed = false;
      const timer = setTimeout(() => { killed = true; process.kill(); }, timeout);
      process.stdout.on('data', (chunk: Buffer) => output += chunk.toString()); process.stderr.on('data', (chunk: Buffer) => output += chunk.toString());
      process.on('error', error => { clearTimeout(timer); request.status = 'failed'; this.update(request, output + error.message, null); reject(error); });
      process.on('close', (code: number | null) => { clearTimeout(timer); request.status = code === 0 ? 'completed' : killed ? 'cancelled' : 'failed'; this.update(request, output, code); code === 0 ? resolve(output) : reject(new Error(output || `Command exited with ${code}`)); });
    });
  }
  reject(request: CommandRequest): void { request.status = 'rejected'; this.update(request); }
  private update(request: CommandRequest, output = '', exitCode: number | null = null): void { this.container.database.transaction(() => { this.container.database.run('UPDATE command_requests SET status = ?, output = ?, exit_code = ?, updated_at = ? WHERE id = ?', [request.status, output, exitCode, Date.now(), request.id]); this.container.database.run('INSERT INTO agent_approvals (id, subject_type, subject_id, approved, created_at) VALUES (?, ?, ?, ?, ?)', [crypto.randomUUID(), 'command', request.id, request.status !== 'rejected' ? 1 : 0, Date.now()]); }); this.container.database.save(); }
}
