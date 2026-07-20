import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveAgentPath } from '../../src/layer3-reasoning/agent/pathGuard';

const ROOT = path.resolve('/repo');
const IGNORED = ['node_modules', '.git', '.env'];

describe('resolveAgentPath', () => {
  describe('accepts paths inside the workspace', () => {
    it('resolves a simple relative path', () => {
      expect(resolveAgentPath(ROOT, 'src/a.ts')).toBe(path.join(ROOT, 'src/a.ts'));
    });

    it('resolves a path that traverses upward but stays inside the root', () => {
      expect(resolveAgentPath(ROOT, 'src/nested/../a.ts')).toBe(path.join(ROOT, 'src/a.ts'));
    });

    it('allows the root itself', () => {
      expect(resolveAgentPath(ROOT, '.')).toBe(ROOT);
    });
  });

  describe('rejects paths outside the workspace', () => {
    it('rejects traversal past the root', () => {
      expect(() => resolveAgentPath(ROOT, '../../etc/passwd')).toThrow(/escapes the selected workspace/);
    });

    it('rejects traversal that only just escapes', () => {
      expect(() => resolveAgentPath(ROOT, '../secrets.txt')).toThrow(/escapes the selected workspace/);
    });

    it('rejects absolute paths', () => {
      expect(() => resolveAgentPath(ROOT, path.resolve('/etc/passwd'))).toThrow(/must be relative/);
    });

    it('rejects an absolute path even when it points inside the root', () => {
      // The agent must always speak in workspace-relative terms, so this is refused
      // on form rather than on destination.
      expect(() => resolveAgentPath(ROOT, path.join(ROOT, 'src/a.ts'))).toThrow(/must be relative/);
    });

    it('rejects the empty path', () => {
      expect(() => resolveAgentPath(ROOT, '')).toThrow(/must be relative/);
    });

    it('rejects a sibling directory that shares the root as a string prefix', () => {
      // Guards the `startsWith(root + sep)` detail: `/repo-evil` must not pass for root `/repo`.
      expect(() => resolveAgentPath(ROOT, '../repo-evil/steal.ts')).toThrow(/escapes the selected workspace/);
    });
  });

  describe('honours ignorePatterns', () => {
    it('blocks a directly named ignored segment', () => {
      expect(() => resolveAgentPath(ROOT, '.env', IGNORED)).toThrow(/excluded by agent.ignorePatterns/);
    });

    it('blocks an ignored segment nested in the path', () => {
      expect(() => resolveAgentPath(ROOT, 'node_modules/pkg/index.js', IGNORED)).toThrow(
        /excluded by agent.ignorePatterns/,
      );
    });

    it('blocks an ignored segment reached via traversal', () => {
      // The check runs on the resolved path, so obfuscation via `..` does not help.
      expect(() => resolveAgentPath(ROOT, 'src/../.env', IGNORED)).toThrow(/excluded by agent.ignorePatterns/);
    });

    it('does not block a file that merely contains an ignored name as a substring', () => {
      expect(resolveAgentPath(ROOT, 'src/.environment.ts', IGNORED)).toBe(path.join(ROOT, 'src/.environment.ts'));
    });

    it('allows everything when no patterns are configured', () => {
      expect(resolveAgentPath(ROOT, 'node_modules/pkg/index.js')).toBe(path.join(ROOT, 'node_modules/pkg/index.js'));
    });
  });
});
