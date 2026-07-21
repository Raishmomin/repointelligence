import { describe, expect, it } from 'vitest';
import { buildExcludeGlob, caseInsensitiveGlob } from '../../src/layer3-reasoning/agent/tools/readTools';

/** The setting's shipped default, per package.json. */
const DEFAULT_IGNORE = ['node_modules', '.git', '.env'];

describe('buildExcludeGlob', () => {
  it('excludes framework build output', () => {
    // The reported failure: "setup new design of footer" on a Next.js project returned
    // .next/server/app/*.html and .rsc bundles from glob, because the exclusion listed
    // only out/dist/build and the compiled routes mirror the real source closely enough
    // to match the same patterns.
    const exclude = buildExcludeGlob(DEFAULT_IGNORE);

    expect(exclude).toContain('.next');
    expect(exclude).toContain('.nuxt');
    expect(exclude).toContain('.svelte-kit');
  });

  it('keeps the directories that were already excluded', () => {
    const exclude = buildExcludeGlob(DEFAULT_IGNORE);

    for (const dir of ['node_modules', '.git', 'out', 'dist', 'build']) {
      expect(exclude).toContain(dir);
    }
  });

  it('still honours user-configured ignore patterns', () => {
    expect(buildExcludeGlob([...DEFAULT_IGNORE, 'secrets'])).toContain('secrets');
  });

  it('produces no empty alternative when the setting is empty', () => {
    // `**/{,out,dist}/**` is not a pattern that reliably matches nothing, and
    // ignorePatterns is user-editable, so a stray empty entry must not reach the glob.
    const exclude = buildExcludeGlob([]);

    expect(exclude).not.toContain('{,');
    expect(exclude).not.toContain(',,');
    expect(exclude).not.toContain(',}');
  });

  it('drops blank and whitespace-only entries', () => {
    const exclude = buildExcludeGlob(['', '   ', 'real']);

    expect(exclude).not.toContain(',,');
    expect(exclude).toContain('real');
  });

  it('does not repeat a directory the user also listed', () => {
    // node_modules is in both lists; a duplicate is harmless to match but makes the
    // pattern grow with every overlapping setting.
    const exclude = buildExcludeGlob(['node_modules']);

    expect(exclude.match(/node_modules/g)).toHaveLength(1);
  });

  it('is a well-formed brace expansion', () => {
    expect(buildExcludeGlob(DEFAULT_IGNORE)).toMatch(/^\*\*\/\{[^{}]+\}\/\*\*$/);
  });
});

describe('caseInsensitiveGlob', () => {
  it('finds a PascalCase component from a lowercase pattern', () => {
    // The reported failure: glob "**/*footer*" returned "No files match" while grep found
    // components/layout/Footer.tsx in the same run. findFiles matches case-sensitively on
    // a case-sensitive filesystem, so the file was there and the pattern could not see it.
    const pattern = caseInsensitiveGlob('**/*footer*');

    expect(pattern).toBe('**/*[fF][oO][oO][tT][eE][rR]*');
  });

  it('leaves glob metacharacters untouched', () => {
    expect(caseInsensitiveGlob('**/*')).toBe('**/*');
    expect(caseInsensitiveGlob('src/**/?')).toBe('[sS][rR][cC]/**/?');
  });

  it('preserves an existing character class', () => {
    // A hand-written [A-Z] must keep meaning "uppercase only".
    expect(caseInsensitiveGlob('[A-Z]*')).toBe('[A-Z]*');
  });

  it('expands extensions so *.tsx matches .TSX', () => {
    expect(caseInsensitiveGlob('**/*.tsx')).toBe('**/*.[tT][sS][xX]');
  });

  it('leaves digits, dots and separators alone', () => {
    expect(caseInsensitiveGlob('v2/a.1')).toBe('[vV]2/[aA].1');
  });

  it('handles brace alternatives', () => {
    expect(caseInsensitiveGlob('**/*.{ts,js}')).toBe('**/*.{[tT][sS],[jJ][sS]}');
  });
});
