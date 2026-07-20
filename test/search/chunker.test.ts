import { describe, expect, it } from 'vitest';
import { chunkFile } from '../../src/layer2-context/search/Chunker';

const FILE = [
  'import x from "x";', // 1
  '', // 2
  'function alpha() {', // 3
  '  return computeSomethingUseful();', // 4
  '}', // 5
  '', // 6
  'function beta() {', // 7
  '  return anotherUsefulComputation();', // 8
  '}', // 9
].join('\n');

describe('chunkFile', () => {
  describe('symbol-level chunking', () => {
    it('produces one chunk per symbol rather than one per file', () => {
      // A single vector for a whole file averages every concept in it into something
      // that matches nothing well.
      const chunks = chunkFile(FILE, [
        { name: 'alpha', kind: 'function', startLine: 3, endLine: 5 },
        { name: 'beta', kind: 'function', startLine: 7, endLine: 9 },
      ]);
      expect(chunks).toHaveLength(2);
    });

    it('includes the symbol name and kind so queries can match identity', () => {
      const [chunk] = chunkFile(FILE, [
        { name: 'alpha', kind: 'function', startLine: 3, endLine: 5 },
      ]);
      expect(chunk.text).toContain('function alpha');
      expect(chunk.text).toContain('computeSomethingUseful');
      expect(chunk.type).toBe('function');
    });

    it('carries the symbol id through when present', () => {
      const [chunk] = chunkFile(FILE, [
        { id: 'sym-1', name: 'alpha', kind: 'function', startLine: 3, endLine: 5 },
      ]);
      expect(chunk.symbolId).toBe('sym-1');
    });

    it('skips symbols whose body is too short to be meaningful', () => {
      expect(chunkFile('const a = 1;\n', [
        { name: 'a', kind: 'constant', startLine: 1, endLine: 1 },
      ])).toEqual([]);
    });
  });

  describe('malformed symbol ranges', () => {
    it('skips a range extending past the end of the file', () => {
      // Line numbers come from a prior parse and can outlive an edit.
      const chunks = chunkFile(FILE, [{ name: 'ghost', kind: 'function', startLine: 3, endLine: 999 }]);
      expect(chunks.every((chunk) => chunk.type === 'file')).toBe(true);
    });

    it('skips an inverted range', () => {
      const chunks = chunkFile(FILE, [{ name: 'bad', kind: 'function', startLine: 8, endLine: 2 }]);
      expect(chunks.every((chunk) => chunk.type === 'file')).toBe(true);
    });

    it('skips a zero or negative start line', () => {
      const chunks = chunkFile(FILE, [{ name: 'bad', kind: 'function', startLine: 0, endLine: 3 }]);
      expect(chunks.every((chunk) => chunk.type === 'file')).toBe(true);
    });
  });

  describe('files without symbols', () => {
    it('falls back to windowed chunks so the file stays searchable', () => {
      const chunks = chunkFile('a'.repeat(100));
      expect(chunks).toHaveLength(1);
      expect(chunks[0].type).toBe('file');
    });

    it('splits large content into multiple windows', () => {
      const chunks = chunkFile('x'.repeat(10_000));
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('returns nothing for empty or whitespace-only content', () => {
      expect(chunkFile('')).toEqual([]);
      expect(chunkFile('   \n\n  ')).toEqual([]);
    });
  });

  it('caps chunk size', () => {
    const huge = ['function big() {', ...Array(500).fill('  doSomethingRepetitive();'), '}'].join('\n');
    const [chunk] = chunkFile(huge, [{ name: 'big', kind: 'function', startLine: 1, endLine: 502 }]);
    expect(chunk.text.length).toBeLessThanOrEqual(4000);
  });
});
