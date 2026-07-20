import { describe, expect, it } from 'vitest';
import { applyInsert, applyStrReplace } from '../../src/layer3-reasoning/agent/tools/strReplace';

describe('applyStrReplace', () => {
  describe('unique matches', () => {
    it('replaces a single occurrence', () => {
      const result = applyStrReplace('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 99;');
      expect(result).toEqual({ ok: true, result: 'const a = 99;\nconst b = 2;\n', count: 1 });
    });

    it('replaces text spanning multiple lines', () => {
      const content = 'function f() {\n  return 1;\n}\n';
      const result = applyStrReplace(content, '  return 1;\n', '  return 2;\n');
      expect(result.ok && result.result).toBe('function f() {\n  return 2;\n}\n');
    });

    it('deletes when new_string is empty', () => {
      const result = applyStrReplace('keep\nremove\nkeep\n', 'remove\n', '');
      expect(result.ok && result.result).toBe('keep\nkeep\n');
    });

    it('preserves indentation exactly', () => {
      const content = '\tif (x) {\n\t\treturn;\n\t}\n';
      const result = applyStrReplace(content, '\t\treturn;', '\t\treturn null;');
      expect(result.ok && result.result).toBe('\tif (x) {\n\t\treturn null;\n\t}\n');
    });

    it('treats $-patterns in new_string literally', () => {
      // String.replace would expand `$&` into the matched text.
      const result = applyStrReplace('value = old;', 'old', '$& $1 $$');
      expect(result.ok && result.result).toBe('value = $& $1 $$;');
    });
  });

  describe('ambiguity is a failure, not a silent first-match', () => {
    it('refuses when the string appears twice', () => {
      const content = 'foo();\nbar();\nfoo();\n';
      const result = applyStrReplace(content, 'foo();', 'baz();');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe('ambiguous');
      expect(!result.ok && result.count).toBe(2);
    });

    it('reports the match count so the model can disambiguate', () => {
      const result = applyStrReplace('x\nx\nx\n', 'x', 'y');
      expect(!result.ok && result.message).toContain('3');
    });

    it('replaces every occurrence when replace_all is set', () => {
      const result = applyStrReplace('foo();\nbar();\nfoo();\n', 'foo();', 'baz();');
      expect(result.ok).toBe(false);

      const all = applyStrReplace('foo();\nbar();\nfoo();\n', 'foo();', 'baz();', true);
      expect(all).toEqual({ ok: true, result: 'baz();\nbar();\nbaz();\n', count: 2 });
    });

    it('counts non-overlapping occurrences', () => {
      // "aa" occurs twice in "aaaa", not three times.
      const result = applyStrReplace('aaaa', 'aa', 'b');
      expect(!result.ok && result.count).toBe(2);
    });

    it('allows a unique match that is a substring of a longer line', () => {
      const result = applyStrReplace('const total = subtotal + tax;', 'subtotal', 'net');
      expect(result.ok && result.result).toBe('const total = net + tax;');
    });
  });

  describe('rejected inputs', () => {
    it('reports not_found with actionable guidance', () => {
      const result = applyStrReplace('hello world', 'goodbye', 'hi');
      expect(!result.ok && result.reason).toBe('not_found');
      expect(!result.ok && result.message).toMatch(/exactly|whitespace/i);
    });

    it('rejects an empty old_string', () => {
      const result = applyStrReplace('content', '', 'new');
      expect(!result.ok && result.reason).toBe('not_found');
      expect(!result.ok && result.message).toContain('create_file');
    });

    it('rejects a no-op edit', () => {
      const result = applyStrReplace('abc', 'b', 'b');
      expect(!result.ok && result.reason).toBe('no_op');
    });

    it('does not match across differing whitespace', () => {
      // Guards against a matcher that normalises whitespace and edits the wrong thing.
      const result = applyStrReplace('if  (x)', 'if (x)', 'if (y)');
      expect(!result.ok && result.reason).toBe('not_found');
    });
  });
});

describe('applyInsert', () => {
  it('inserts at the top of the file with line 0', () => {
    const result = applyInsert('a\nb\n', 0, "import x from 'x';");
    expect(result.ok && result.result).toBe("import x from 'x';\na\nb\n");
  });

  it('inserts after the given line', () => {
    const result = applyInsert('a\nb\nc\n', 2, 'inserted');
    expect(result.ok && result.result).toBe('a\nb\ninserted\nc\n');
  });

  it('inserts multiple lines', () => {
    const result = applyInsert('a\n', 1, 'x\ny');
    expect(result.ok && result.result).toBe('a\nx\ny\n');
  });

  it('tolerates a trailing newline on the inserted text', () => {
    const withNewline = applyInsert('a\nb\n', 1, 'x\n');
    const without = applyInsert('a\nb\n', 1, 'x');
    expect(withNewline).toEqual(without);
  });

  it('rejects a line number past the end of the file', () => {
    const result = applyInsert('a\nb\n', 99, 'x');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('between 0 and');
  });

  it('rejects negative and non-integer line numbers', () => {
    expect(applyInsert('a\n', -1, 'x').ok).toBe(false);
    expect(applyInsert('a\n', 1.5, 'x').ok).toBe(false);
  });

  it('handles an empty file', () => {
    const result = applyInsert('', 0, 'first');
    expect(result.ok && result.result).toBe('first\n');
  });
});
