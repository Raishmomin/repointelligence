import { contentHash } from './AgentSafety';

/**
 * Enforces the Read-before-Edit invariant for a single agent run.
 *
 * Two failure modes this exists to prevent:
 *
 *  1. Editing a file the agent has not read. Without a read, `old_string` is a guess, and
 *     a guess that happens to match edits code nobody looked at.
 *  2. Editing a file that changed after the agent read it — the user saved in the editor,
 *     a formatter ran, another tool wrote to it. The agent's mental model is stale and the
 *     edit would be applied to different content than it reasoned about.
 *
 * Both are reported as recoverable tool errors rather than exceptions: the model is told
 * what went wrong and can re-read and retry. Throwing would end a run over a mistake the
 * model is perfectly capable of fixing.
 */

export interface TrackedFile {
  relativePath: string;
  contentHash: string;
  readAtTurn: number;
}

export type FreshnessCheck =
  | { ok: true }
  | { ok: false; reason: 'never_read' | 'stale'; message: string };

export class FileStateTracker {
  private readonly files = new Map<string, TrackedFile>();

  recordRead(relativePath: string, content: string, turn: number): void {
    this.files.set(relativePath, {
      relativePath,
      contentHash: contentHash(content),
      readAtTurn: turn,
    });
  }

  /** Called after a file is created so the agent may edit it without a redundant read. */
  recordWrite(relativePath: string, content: string, turn: number): void {
    this.recordRead(relativePath, content, turn);
  }

  get(relativePath: string): TrackedFile | undefined {
    return this.files.get(relativePath);
  }

  hasRead(relativePath: string): boolean {
    return this.files.has(relativePath);
  }

  /**
   * The gate every edit tool runs before touching disk.
   *
   * @param currentContent Content just re-read from disk, not the content from the
   *                       original read — comparing a cached value against itself would
   *                       make the staleness check meaningless.
   */
  checkEditable(relativePath: string, currentContent: string): FreshnessCheck {
    const tracked = this.files.get(relativePath);

    if (!tracked) {
      return {
        ok: false,
        reason: 'never_read',
        message:
          `You have not read ${relativePath} during this run. ` +
          'Call read_file on it before editing, so your edit is based on its actual contents.',
      };
    }

    if (tracked.contentHash !== contentHash(currentContent)) {
      return {
        ok: false,
        reason: 'stale',
        message:
          `${relativePath} has changed on disk since you read it. ` +
          'Read it again before editing — your previous view of the file is out of date.',
      };
    }

    return { ok: true };
  }

  /**
   * Marks a file as unread following an external change. Wired to the workspace file
   * watcher so a mid-run edit by the user is caught immediately rather than at apply time.
   */
  invalidate(relativePath: string): void {
    this.files.delete(relativePath);
  }

  invalidateAll(): void {
    this.files.clear();
  }

  /** Files read during this run, for diagnostics and transcript compaction decisions. */
  trackedPaths(): string[] {
    return [...this.files.keys()];
  }
}
