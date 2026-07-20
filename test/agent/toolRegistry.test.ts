import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/layer3-reasoning/agent/ToolRegistry';
import { ToolContext } from '../../src/layer3-reasoning/agent/tools/types';

/**
 * The context is never reached by these cases — each one is rejected before execution —
 * so a bare cast is sufficient and keeps the test free of extension-host machinery.
 */
const CONTEXT = {} as ToolContext;

describe('ToolRegistry', () => {
  const registry = new ToolRegistry();

  describe('schema stability', () => {
    it('sorts tools by name', () => {
      const names = registry.schemas().map((schema) => schema.name);
      expect(names).toEqual([...names].sort());
    });

    it('returns an identical list on every call', () => {
      // Tools render at position 0 of the cached prefix: any variation between requests
      // invalidates the prompt cache for the whole run.
      expect(JSON.stringify(registry.schemas())).toBe(JSON.stringify(registry.schemas()));
    });

    it('exposes the full tool set', () => {
      expect(registry.names()).toEqual([
        'create_file',
        'delete_file',
        'glob',
        'grep',
        'insert_lines',
        'query_index',
        'read_file',
        'rename_file',
        'run_command',
        'str_replace',
      ]);
    });
  });

  describe('failures are results, not exceptions', () => {
    it('reports an unknown tool and lists the valid ones', async () => {
      const outcome = await registry.execute('nonexistent', {}, CONTEXT, 'implement');
      expect(outcome).toMatchObject({ kind: 'result', isError: true });
      expect(outcome.kind === 'result' && outcome.content).toContain('Unknown tool');
      expect(outcome.kind === 'result' && outcome.content).toContain('read_file');
    });

    it('reports invalid arguments without throwing', async () => {
      const outcome = await registry.execute('read_file', { wrong: 'field' }, CONTEXT, 'implement');
      expect(outcome).toMatchObject({ kind: 'result', isError: true });
      expect(outcome.kind === 'result' && outcome.content).toContain('Invalid arguments');
    });

    it('reports non-object arguments without throwing', async () => {
      const outcome = await registry.execute('read_file', 'a string', CONTEXT, 'implement');
      expect(outcome).toMatchObject({ kind: 'result', isError: true });
    });
  });

  describe('mode enforcement', () => {
    it('blocks writes in explain mode', async () => {
      const outcome = await registry.execute(
        'str_replace',
        { path: 'a.ts', old_string: 'x', new_string: 'y' },
        CONTEXT,
        'explain',
      );
      expect(outcome).toMatchObject({ kind: 'result', isError: true });
      expect(outcome.kind === 'result' && outcome.content).toContain('explain mode');
    });

    it('blocks writes in plan mode', async () => {
      const outcome = await registry.execute('delete_file', { path: 'a.ts' }, CONTEXT, 'plan');
      expect(outcome).toMatchObject({ kind: 'result', isError: true });
    });

    it('blocks commands outside implement mode', async () => {
      const outcome = await registry.execute(
        'run_command',
        { command: 'npm', args: ['test'], reason: 'verify' },
        CONTEXT,
        'plan',
      );
      expect(outcome).toMatchObject({ kind: 'result', isError: true });
    });

    it('rejects the write before validating its arguments', async () => {
      // The mode gate must not be reachable only via a well-formed call.
      const outcome = await registry.execute('str_replace', {}, CONTEXT, 'explain');
      expect(outcome.kind === 'result' && outcome.content).toContain('explain mode');
    });

    it('still offers every tool to the model in read-only modes', () => {
      // Withholding tools per mode would invalidate the cached prefix, so the tool list
      // is constant and the restriction is applied at execution time.
      expect(registry.names()).toContain('str_replace');
    });
  });

  describe('lookup', () => {
    it('resolves a known tool', () => {
      expect(registry.get('read_file')?.name).toBe('read_file');
    });

    it('returns undefined for an unknown tool', () => {
      expect(registry.get('nope')).toBeUndefined();
    });
  });
});
