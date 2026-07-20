import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { Logger } from '../../shared/Logger';

export interface GitStatusEntry {
  path: string;
  status: string;
}

export interface Checkpoint {
  /** SHA of a dangling commit object capturing the working tree at checkpoint time. */
  ref: string;
  createdAt: number;
}

/**
 * Read-only git information plus working-tree checkpoints.
 *
 * Checkpoints deliberately use `git stash create`, which writes a dangling commit object
 * and changes nothing else — no stash entry, no index mutation, no HEAD movement, nothing
 * in `git log`. `git stash` or `git commit` would rewrite state the user did not ask us to
 * touch, and an agent silently committing over someone's staged work is unforgivable.
 *
 * Every method degrades quietly: not a repository, git missing, or a command failing all
 * return empty rather than throwing, because none of this is essential to applying a change.
 */
export class GitService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger = Logger.getInstance(),
  ) {}

  isRepository(): boolean {
    return this.exec(['rev-parse', '--git-dir']) !== undefined;
  }

  getCurrentBranch(): string | undefined {
    return this.exec(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || undefined;
  }

  /** Files differing from HEAD, in porcelain form. */
  getStatus(): GitStatusEntry[] {
    const output = this.exec(['status', '--porcelain']);
    if (!output) return [];

    return output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
  }

  /** Paths with uncommitted changes — useful context for the agent's system prompt. */
  getDirtyFiles(): string[] {
    return this.getStatus().map((entry) => entry.path);
  }

  getDiff(relativePath?: string): string {
    const args = ['diff', 'HEAD'];
    if (relativePath) args.push('--', relativePath);
    return this.exec(args) ?? '';
  }

  /**
   * Captures the current working tree as a dangling commit.
   *
   * Returns undefined when there is nothing to capture — `git stash create` prints nothing
   * on a clean tree, which is correct: there is no state to restore to.
   */
  createCheckpoint(): Checkpoint | undefined {
    if (!this.isRepository()) return undefined;

    const ref = this.exec(['stash', 'create'])?.trim();
    if (!ref) return undefined;

    this.logger.debug('Created git checkpoint', { ref });
    return { ref, createdAt: Date.now() };
  }

  /**
   * Restores the given paths from a checkpoint.
   *
   * Scoped to the paths the change set touched rather than the whole tree, so reverting an
   * agent change cannot discard unrelated work the user did in the meantime.
   */
  restoreCheckpoint(checkpoint: Checkpoint, relativePaths: string[]): boolean {
    if (!relativePaths.length) return false;

    const result = this.exec(['checkout', checkpoint.ref, '--', ...relativePaths]);
    if (result === undefined) {
      this.logger.warn('Could not restore git checkpoint; falling back to content snapshots.');
      return false;
    }
    return true;
  }

  /** Whether a checkpoint object still exists — dangling commits can be garbage collected. */
  checkpointExists(ref: string): boolean {
    return this.exec(['cat-file', '-e', `${ref}^{commit}`]) !== undefined;
  }

  /**
   * Runs git with arguments passed separately — never through a shell — so a path
   * containing shell metacharacters cannot become an injection.
   *
   * @returns stdout, or undefined if git is unavailable or the command failed.
   */
  private exec(args: string[]): string | undefined {
    try {
      return childProcess.execFileSync('git', args, {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      });
    } catch {
      return undefined;
    }
  }
}

/** Builds a GitService for a workspace folder, or undefined when it is not a repository. */
export function gitServiceFor(workspace: vscode.WorkspaceFolder): GitService | undefined {
  const service = new GitService(workspace.uri.fsPath);
  return service.isRepository() ? service : undefined;
}
