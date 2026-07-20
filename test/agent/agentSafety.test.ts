import { describe, expect, it } from 'vitest';
import {
  classifyFileRisk,
  contentHash,
  isSafeCommand,
} from '../../src/layer3-reasoning/agent/AgentSafety';

describe('classifyFileRisk', () => {
  it('treats destructive operations as high risk regardless of path', () => {
    expect(classifyFileRisk('delete', 'src/a.ts')).toBe('high');
    expect(classifyFileRisk('rename', 'src/a.ts')).toBe('high');
  });

  it('treats secret-bearing files as high risk', () => {
    expect(classifyFileRisk('edit', '.env')).toBe('high');
    expect(classifyFileRisk('edit', 'config/secrets.ts')).toBe('high');
    expect(classifyFileRisk('edit', 'app/credentials.json')).toBe('high');
  });

  it('treats build and dependency configuration as medium risk', () => {
    expect(classifyFileRisk('edit', 'package.json')).toBe('medium');
    expect(classifyFileRisk('edit', 'vite.config.ts')).toBe('medium');
    expect(classifyFileRisk('edit', 'tsconfig.json')).toBe('medium');
  });

  it('treats lockfiles from every ecosystem as medium risk', () => {
    // Lockfile naming is inconsistent, and anchoring on a trailing "lock" quietly missed
    // most of them.
    expect(classifyFileRisk('edit', 'yarn.lock')).toBe('medium');
    expect(classifyFileRisk('edit', 'package-lock.json')).toBe('medium');
    expect(classifyFileRisk('edit', 'pnpm-lock.yaml')).toBe('medium');
    expect(classifyFileRisk('edit', 'Cargo.lock')).toBe('medium');
    expect(classifyFileRisk('edit', 'poetry.lock')).toBe('medium');
  });

  it('treats ordinary source edits as low risk', () => {
    expect(classifyFileRisk('edit', 'src/components/Button.tsx')).toBe('low');
    expect(classifyFileRisk('create', 'src/utils/format.ts')).toBe('low');
  });
});

describe('isSafeCommand', () => {
  it('accepts a bare executable with separate arguments', () => {
    expect(isSafeCommand('npm', ['run', 'test'])).toBe(true);
    expect(isSafeCommand('pytest', ['-q'])).toBe(true);
  });

  it('rejects shell syntax smuggled into the executable', () => {
    // spawn runs with shell:false, so the executable must be a single literal token.
    expect(isSafeCommand('sh -c', ['echo x'])).toBe(false);
    expect(isSafeCommand('npm run test', [])).toBe(false);
    expect(isSafeCommand('rm -rf /; echo', [])).toBe(false);
    expect(isSafeCommand('cat file | grep x', [])).toBe(false);
  });

  it('rejects arguments carrying newlines or null bytes', () => {
    expect(isSafeCommand('npm', ['test\nrm -rf /'])).toBe(false);
    expect(isSafeCommand('npm', ['test\0'])).toBe(false);
  });

  it('allows arguments that merely contain shell-significant characters', () => {
    // Passed as a literal argv entry, these are inert — no shell interprets them.
    expect(isSafeCommand('grep', ['a|b'])).toBe(true);
    expect(isSafeCommand('node', ['-e', 'console.log(1 && 2)'])).toBe(true);
  });
});

describe('contentHash', () => {
  it('distinguishes different content', () => {
    expect(contentHash('before')).not.toBe(contentHash('after'));
  });

  it('is stable for identical content', () => {
    expect(contentHash('same')).toBe(contentHash('same'));
  });

  it('detects whitespace-only differences, which a formatter would introduce', () => {
    expect(contentHash('if (x) {\n  y();\n}')).not.toBe(contentHash('if (x) {\n    y();\n}'));
  });

  it('handles empty content', () => {
    expect(contentHash('')).toHaveLength(64);
  });
});
