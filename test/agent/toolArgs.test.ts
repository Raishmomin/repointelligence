import { describe, expect, it } from 'vitest';
import { globTool, grepTool, queryIndexTool, readFileTool } from '../../src/layer3-reasoning/agent/tools/readTools';
import {
  createFileTool,
  deleteFileTool,
  insertTool,
  renameFileTool,
  runCommandTool,
  strReplaceTool,
} from '../../src/layer3-reasoning/agent/tools/writeTools';
import { AgentTool } from '../../src/layer3-reasoning/agent/tools/types';

const ALL: AgentTool<never>[] = [
  readFileTool,
  globTool,
  grepTool,
  queryIndexTool,
  strReplaceTool,
  insertTool,
  createFileTool,
  deleteFileTool,
  renameFileTool,
  runCommandTool,
] as AgentTool<never>[];

describe('tool argument validation', () => {
  describe('every tool rejects structurally invalid input', () => {
    it.each(ALL.map((tool) => [tool.name, tool] as const))('%s', (_name, tool) => {
      for (const bad of [null, undefined, 'a string', 42, []]) {
        expect(() => tool.parseArgs(bad)).toThrow();
      }
    });

    it.each(ALL.map((tool) => [tool.name, tool] as const))('%s rejects an empty object', (_name, tool) => {
      expect(() => tool.parseArgs({})).toThrow();
    });
  });

  describe('read_file', () => {
    it('accepts just a path', () => {
      expect(readFileTool.parseArgs({ path: 'src/a.ts' })).toEqual({
        path: 'src/a.ts',
        offset: undefined,
        limit: undefined,
      });
    });

    it('accepts optional paging', () => {
      expect(readFileTool.parseArgs({ path: 'a.ts', offset: 10, limit: 50 })).toMatchObject({
        offset: 10,
        limit: 50,
      });
    });

    it('coerces numeric strings, which models emit often', () => {
      expect(readFileTool.parseArgs({ path: 'a.ts', offset: '10' })).toMatchObject({ offset: 10 });
    });

    it('rejects a non-numeric offset', () => {
      expect(() => readFileTool.parseArgs({ path: 'a.ts', offset: 'ten' })).toThrow(/must be a number/);
    });

    it('rejects an empty path', () => {
      expect(() => readFileTool.parseArgs({ path: '' })).toThrow(/non-empty/);
    });
  });

  describe('str_replace', () => {
    it('accepts a minimal edit', () => {
      expect(strReplaceTool.parseArgs({ path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({
        path: 'a.ts',
        old_string: 'x',
        new_string: 'y',
        replace_all: undefined,
        reason: undefined,
      });
    });

    it('accepts an empty new_string, which means deletion', () => {
      expect(strReplaceTool.parseArgs({ path: 'a.ts', old_string: 'x', new_string: '' })).toMatchObject({
        new_string: '',
      });
    });

    it('rejects a missing new_string', () => {
      expect(() => strReplaceTool.parseArgs({ path: 'a.ts', old_string: 'x' })).toThrow(/new_string/);
    });

    it('rejects an empty old_string', () => {
      expect(() => strReplaceTool.parseArgs({ path: 'a.ts', old_string: '', new_string: 'y' })).toThrow();
    });

    it('accepts string booleans for replace_all', () => {
      expect(
        strReplaceTool.parseArgs({ path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: 'true' }),
      ).toMatchObject({ replace_all: true });
    });

    it('rejects a non-boolean replace_all', () => {
      expect(() =>
        strReplaceTool.parseArgs({ path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: 'yes' }),
      ).toThrow(/boolean/);
    });
  });

  describe('insert_lines', () => {
    it('accepts line 0', () => {
      expect(insertTool.parseArgs({ path: 'a.ts', insert_line: 0, text: 'x' })).toMatchObject({
        insert_line: 0,
      });
    });

    it('accepts empty text', () => {
      expect(insertTool.parseArgs({ path: 'a.ts', insert_line: 1, text: '' })).toMatchObject({ text: '' });
    });

    it('rejects a missing insert_line', () => {
      expect(() => insertTool.parseArgs({ path: 'a.ts', text: 'x' })).toThrow(/insert_line/);
    });

    it('rejects non-string text', () => {
      expect(() => insertTool.parseArgs({ path: 'a.ts', insert_line: 1, text: 42 })).toThrow(/text/);
    });
  });

  describe('create_file', () => {
    it('accepts empty content', () => {
      expect(createFileTool.parseArgs({ path: 'a.ts', content: '' })).toMatchObject({ content: '' });
    });

    it('rejects missing content', () => {
      expect(() => createFileTool.parseArgs({ path: 'a.ts' })).toThrow(/content/);
    });
  });

  describe('rename_file', () => {
    it('requires both paths', () => {
      expect(() => renameFileTool.parseArgs({ path: 'a.ts' })).toThrow(/new_path/);
      expect(() => renameFileTool.parseArgs({ new_path: 'b.ts' })).toThrow(/path/);
    });
  });

  describe('delete_file', () => {
    it('accepts a path with an optional reason', () => {
      expect(deleteFileTool.parseArgs({ path: 'a.ts', reason: 'obsolete' })).toEqual({
        path: 'a.ts',
        reason: 'obsolete',
      });
    });

    it('rejects a non-string reason', () => {
      expect(() => deleteFileTool.parseArgs({ path: 'a.ts', reason: 42 })).toThrow(/string/);
    });
  });

  describe('run_command', () => {
    it('accepts an executable with separate args', () => {
      expect(runCommandTool.parseArgs({ command: 'npm', args: ['run', 'test'], reason: 'verify' })).toEqual({
        command: 'npm',
        args: ['run', 'test'],
        reason: 'verify',
      });
    });

    it('accepts an empty args array', () => {
      expect(runCommandTool.parseArgs({ command: 'ls', args: [], reason: 'list' })).toMatchObject({ args: [] });
    });

    it('rejects args that is not an array', () => {
      expect(() => runCommandTool.parseArgs({ command: 'npm', args: 'run test', reason: 'x' })).toThrow(
        /array of strings/,
      );
    });

    it('rejects an args array containing non-strings', () => {
      expect(() => runCommandTool.parseArgs({ command: 'npm', args: ['run', 42], reason: 'x' })).toThrow(
        /array of strings/,
      );
    });

    it('requires a reason, since the user has to approve it', () => {
      expect(() => runCommandTool.parseArgs({ command: 'npm', args: ['test'] })).toThrow(/reason/);
    });
  });
});

describe('tool declarations', () => {
  it('classifies approval correctly', () => {
    expect(readFileTool.approval).toBe('auto');
    expect(globTool.approval).toBe('auto');
    expect(grepTool.approval).toBe('auto');
    expect(queryIndexTool.approval).toBe('auto');

    expect(strReplaceTool.approval).toBe('file-write');
    expect(createFileTool.approval).toBe('file-write');
    expect(deleteFileTool.approval).toBe('file-write');
    expect(renameFileTool.approval).toBe('file-write');
    expect(insertTool.approval).toBe('file-write');

    expect(runCommandTool.approval).toBe('command');
  });

  it('declares every required property as an actual property', () => {
    for (const tool of ALL) {
      const schema = tool.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      for (const field of schema.required ?? []) {
        expect(Object.keys(schema.properties)).toContain(field);
      }
    }
  });

  it('describes when to use the tool, not only what it does', () => {
    // Trigger conditions measurably improve whether the right tool gets called.
    for (const tool of ALL) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('uses unique names', () => {
    const names = ALL.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
