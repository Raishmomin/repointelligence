import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../../src/layer1-intelligence/git/GitService';

/**
 * Runs against a real temporary repository. Checkpointing is the mechanism a user relies
 * on to undo an agent's work, and its whole value rests on `git stash create` leaving
 * every other piece of git state untouched — which only a real repository can demonstrate.
 */

let repo: string;
let available = true;

function git(args: string[], cwd: string): string {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

beforeAll(() => {
  try {
    childProcess.execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    available = false;
    return;
  }

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repoanalyser-git-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const value = 1;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'initial'], repo);
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe.runIf(available !== false)('GitService', () => {
  describe('repository detection', () => {
    it('recognises a repository', () => {
      expect(new GitService(repo).isRepository()).toBe(true);
    });

    it('reports a non-repository directory without throwing', () => {
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'repoanalyser-plain-'));
      try {
        expect(new GitService(plain).isRepository()).toBe(false);
      } finally {
        fs.rmSync(plain, { recursive: true, force: true });
      }
    });

    it('degrades quietly on a path that does not exist', () => {
      const service = new GitService(path.join(os.tmpdir(), 'definitely-not-here-12345'));
      expect(service.isRepository()).toBe(false);
      expect(service.getStatus()).toEqual([]);
      expect(service.getDirtyFiles()).toEqual([]);
      expect(service.getCurrentBranch()).toBeUndefined();
      expect(service.createCheckpoint()).toBeUndefined();
    });
  });

  describe('status', () => {
    it('reports a clean tree as clean', () => {
      expect(new GitService(repo).getDirtyFiles()).toEqual([]);
    });

    it('reports a modified file', () => {
      fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const value = 2;\n');
      try {
        expect(new GitService(repo).getDirtyFiles()).toContain('tracked.ts');
      } finally {
        git(['checkout', '--', 'tracked.ts'], repo);
      }
    });

    it('names the current branch', () => {
      expect(new GitService(repo).getCurrentBranch()).toBeTruthy();
    });
  });

  describe('checkpoints', () => {
    it('returns nothing for a clean tree, since there is no state to restore', () => {
      expect(new GitService(repo).createCheckpoint()).toBeUndefined();
    });

    it('captures a dirty tree and restores it exactly', () => {
      const file = path.join(repo, 'tracked.ts');
      fs.writeFileSync(file, 'export const value = 99; // user edit\n');

      const service = new GitService(repo);
      const checkpoint = service.createCheckpoint();
      expect(checkpoint?.ref).toMatch(/^[0-9a-f]{40}$/);

      // Simulate the agent overwriting the user's in-progress work.
      fs.writeFileSync(file, 'export const value = 0; // agent edit\n');
      expect(service.restoreCheckpoint(checkpoint!, ['tracked.ts'])).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('export const value = 99; // user edit\n');

      git(['checkout', '--', 'tracked.ts'], repo);
    });

    it('leaves every other piece of git state untouched', () => {
      // The reason for `git stash create` over `git stash` or `git commit`: an agent must
      // not silently rewrite the user's history, stash list, or staged work.
      const file = path.join(repo, 'tracked.ts');
      fs.writeFileSync(file, 'export const value = 42;\n');

      const logBefore = git(['log', '--oneline'], repo);
      const stashBefore = git(['stash', 'list'], repo);
      const headBefore = git(['rev-parse', 'HEAD'], repo);

      new GitService(repo).createCheckpoint();

      expect(git(['log', '--oneline'], repo)).toBe(logBefore);
      expect(git(['stash', 'list'], repo)).toBe(stashBefore);
      expect(git(['rev-parse', 'HEAD'], repo)).toBe(headBefore);
      // The working tree still holds the uncommitted change — nothing was reverted.
      expect(fs.readFileSync(file, 'utf8')).toBe('export const value = 42;\n');

      git(['checkout', '--', 'tracked.ts'], repo);
    });

    it('confirms a checkpoint still exists, and that a bogus ref does not', () => {
      fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const value = 7;\n');
      const service = new GitService(repo);
      const checkpoint = service.createCheckpoint()!;

      expect(service.checkpointExists(checkpoint.ref)).toBe(true);
      expect(service.checkpointExists('0000000000000000000000000000000000000000')).toBe(false);

      git(['checkout', '--', 'tracked.ts'], repo);
    });

    it('refuses to restore with no paths, rather than touching the whole tree', () => {
      const service = new GitService(repo);
      expect(service.restoreCheckpoint({ ref: 'HEAD', createdAt: 0 }, [])).toBe(false);
    });
  });

  describe('command construction', () => {
    it('passes paths as arguments, so shell metacharacters cannot inject', () => {
      const service = new GitService(repo);
      // Treated as a literal (absent) filename by git, never interpreted by a shell.
      expect(() => service.getDiff('file.ts; rm -rf /')).not.toThrow();
    });
  });
});
