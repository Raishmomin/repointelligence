import { beforeEach, describe, expect, it } from 'vitest';
import { FileStateTracker } from '../../src/layer3-reasoning/agent/FileStateTracker';

describe('FileStateTracker', () => {
  let tracker: FileStateTracker;

  beforeEach(() => {
    tracker = new FileStateTracker();
  });

  describe('Read-before-Edit', () => {
    it('rejects an edit to a file that was never read', () => {
      const check = tracker.checkEditable('src/a.ts', 'contents');
      expect(check.ok).toBe(false);
      expect(!check.ok && check.reason).toBe('never_read');
    });

    it('names the file and the required action in the message', () => {
      const check = tracker.checkEditable('src/a.ts', 'contents');
      expect(!check.ok && check.message).toContain('src/a.ts');
      expect(!check.ok && check.message).toContain('read_file');
    });

    it('allows an edit after a read of unchanged content', () => {
      tracker.recordRead('src/a.ts', 'contents', 0);
      expect(tracker.checkEditable('src/a.ts', 'contents')).toEqual({ ok: true });
    });

    it('tracks files independently', () => {
      tracker.recordRead('src/a.ts', 'a', 0);
      expect(tracker.checkEditable('src/a.ts', 'a').ok).toBe(true);
      expect(tracker.checkEditable('src/b.ts', 'b').ok).toBe(false);
    });
  });

  describe('staleness', () => {
    it('rejects an edit when the file changed after being read', () => {
      tracker.recordRead('src/a.ts', 'original', 0);
      const check = tracker.checkEditable('src/a.ts', 'modified externally');
      expect(check.ok).toBe(false);
      expect(!check.ok && check.reason).toBe('stale');
    });

    it('tells the model to re-read rather than failing opaquely', () => {
      tracker.recordRead('src/a.ts', 'original', 0);
      const check = tracker.checkEditable('src/a.ts', 'changed');
      expect(!check.ok && check.message).toMatch(/read it again/i);
    });

    it('detects a whitespace-only change', () => {
      // A formatter running mid-run is exactly this case.
      tracker.recordRead('src/a.ts', 'if (x) {\n  y();\n}', 0);
      const check = tracker.checkEditable('src/a.ts', 'if (x) {\n    y();\n}');
      expect(!check.ok && check.reason).toBe('stale');
    });

    it('accepts the file again after a fresh read of the new content', () => {
      tracker.recordRead('src/a.ts', 'original', 0);
      expect(tracker.checkEditable('src/a.ts', 'changed').ok).toBe(false);

      tracker.recordRead('src/a.ts', 'changed', 1);
      expect(tracker.checkEditable('src/a.ts', 'changed').ok).toBe(true);
    });

    it('treats an emptied file as stale rather than unread', () => {
      tracker.recordRead('src/a.ts', 'content', 0);
      const check = tracker.checkEditable('src/a.ts', '');
      expect(!check.ok && check.reason).toBe('stale');
    });
  });

  describe('invalidation', () => {
    it('drops a file back to never_read', () => {
      tracker.recordRead('src/a.ts', 'contents', 0);
      tracker.invalidate('src/a.ts');

      const check = tracker.checkEditable('src/a.ts', 'contents');
      expect(!check.ok && check.reason).toBe('never_read');
    });

    it('only affects the named file', () => {
      tracker.recordRead('src/a.ts', 'a', 0);
      tracker.recordRead('src/b.ts', 'b', 0);
      tracker.invalidate('src/a.ts');

      expect(tracker.checkEditable('src/a.ts', 'a').ok).toBe(false);
      expect(tracker.checkEditable('src/b.ts', 'b').ok).toBe(true);
    });

    it('ignores invalidation of an untracked file', () => {
      expect(() => tracker.invalidate('never/seen.ts')).not.toThrow();
    });

    it('clears every file with invalidateAll', () => {
      tracker.recordRead('src/a.ts', 'a', 0);
      tracker.recordRead('src/b.ts', 'b', 0);
      tracker.invalidateAll();
      expect(tracker.trackedPaths()).toEqual([]);
    });
  });

  describe('created files', () => {
    it('are editable without a separate read', () => {
      // The agent just wrote the content, so it already knows it.
      tracker.recordWrite('src/new.ts', 'generated', 0);
      expect(tracker.checkEditable('src/new.ts', 'generated').ok).toBe(true);
    });
  });

  describe('bookkeeping', () => {
    it('records the turn a file was read on', () => {
      tracker.recordRead('src/a.ts', 'contents', 7);
      expect(tracker.get('src/a.ts')?.readAtTurn).toBe(7);
    });

    it('overwrites the turn on re-read', () => {
      tracker.recordRead('src/a.ts', 'v1', 1);
      tracker.recordRead('src/a.ts', 'v2', 5);
      expect(tracker.get('src/a.ts')?.readAtTurn).toBe(5);
    });

    it('reports which files have been read', () => {
      tracker.recordRead('src/a.ts', 'a', 0);
      tracker.recordRead('src/b.ts', 'b', 0);
      expect(tracker.trackedPaths().sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(tracker.hasRead('src/a.ts')).toBe(true);
      expect(tracker.hasRead('src/c.ts')).toBe(false);
    });
  });
});
