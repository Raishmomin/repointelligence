import { describe, expect, it } from 'vitest';
import { ToolCallAssembler } from '../../src/layer3-reasoning/providers/openai-compat/ToolCallAssembler';
import { LlmStreamEvent } from '../../src/layer3-reasoning/providers/types';

function collect() {
  const events: LlmStreamEvent[] = [];
  return { events, emit: (event: LlmStreamEvent) => void events.push(event) };
}

describe('ToolCallAssembler', () => {
  describe('the normal OpenAI shape', () => {
    it('assembles a call from fragments spread across chunks', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '' } }], emit);
      assembler.push([{ index: 0, function: { arguments: '{"pa' } }], emit);
      assembler.push([{ index: 0, function: { arguments: 'th":"src/a.ts"}' } }], emit);

      const { blocks } = assembler.finish(emit);
      expect(blocks).toEqual([
        { type: 'tool_use', id: 'call_abc', name: 'read_file', input: { path: 'src/a.ts' } },
      ]);
    });

    it('emits start once, then one input event per argument fragment, then end', () => {
      const assembler = new ToolCallAssembler('test');
      const { events, emit } = collect();

      assembler.push([{ index: 0, id: 'c1', function: { name: 'grep', arguments: '{"p' } }], emit);
      assembler.push([{ index: 0, function: { arguments: '":"x"}' } }], emit);
      assembler.finish(emit);

      expect(events.map((e) => e.type)).toEqual([
        'tool_use_start',
        'tool_use_input',
        'tool_use_input',
        'tool_use_end',
      ]);
    });

    it('handles parallel calls', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push(
        [
          { index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { index: 1, id: 'b', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
        ],
        emit,
      );

      const { blocks } = assembler.finish(emit);
      expect(blocks.map((b) => b.name)).toEqual(['read_file', 'grep']);
    });
  });

  describe('vendor deviations', () => {
    it('synthesises a stable id when the vendor omits one', () => {
      // Gemini's compat layer and several NIM models never send an id.
      const assembler = new ToolCallAssembler('nonce1');
      const { emit } = collect();

      assembler.push([{ index: 0, function: { name: 'read_file', arguments: '{}' } }], emit);
      const { blocks } = assembler.finish(emit);

      expect(blocks[0].id).toBe('call_nonce1_0');
    });

    it('keeps synthesised ids distinct across parallel calls', () => {
      // A collision would pair a tool_result with the wrong tool_use.
      const assembler = new ToolCallAssembler('nonce1');
      const { emit } = collect();

      assembler.push(
        [
          { index: 0, function: { name: 'read_file', arguments: '{}' } },
          { index: 1, function: { name: 'grep', arguments: '{}' } },
        ],
        emit,
      );

      const { blocks } = assembler.finish(emit);
      expect(new Set(blocks.map((b) => b.id)).size).toBe(2);
    });

    it('appends a fragmented function name rather than overwriting it', () => {
      // Assigning would keep only "file" out of "read_" + "file", failing tool lookup.
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ index: 0, id: 'c1', function: { name: 'read_' } }], emit);
      assembler.push([{ index: 0, function: { name: 'file', arguments: '{}' } }], emit);

      const { blocks } = assembler.finish(emit);
      expect(blocks[0].name).toBe('read_file');
    });

    it('defaults a missing index to 0', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ id: 'c1', function: { name: 'grep', arguments: '{"pattern":"x"}' } }], emit);
      expect(assembler.finish(emit).blocks).toHaveLength(1);
    });

    it('orders by index even when the vendor interleaves them', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      // Index 1 announced before index 0.
      assembler.push([{ index: 1, id: 'b', function: { name: 'second' } }], emit);
      assembler.push([{ index: 0, id: 'a', function: { name: 'first' } }], emit);
      assembler.push([{ index: 1, function: { arguments: '{}' } }], emit);
      assembler.push([{ index: 0, function: { arguments: '{}' } }], emit);

      expect(assembler.finish(emit).blocks.map((b) => b.name)).toEqual(['first', 'second']);
    });
  });

  describe('argument edge cases', () => {
    it('treats empty arguments as an empty object', () => {
      // JSON.parse("") throws — without this every no-argument tool call is dropped.
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ index: 0, id: 'c1', function: { name: 'git_status', arguments: '' } }], emit);
      expect(assembler.finish(emit).blocks[0].input).toEqual({});
    });

    it('treats absent arguments as an empty object', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ index: 0, id: 'c1', function: { name: 'git_status' } }], emit);
      expect(assembler.finish(emit).blocks[0].input).toEqual({});
    });

    it('reports malformed arguments instead of dropping them silently', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }], emit);
      const { blocks, malformed } = assembler.finish(emit);

      expect(blocks).toHaveLength(0);
      expect(malformed).toEqual([{ name: 'read_file', args: '{"pa' }]);
    });

    it('rejects a non-object argument payload', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ index: 0, id: 'c1', function: { name: 'x', arguments: '"a string"' } }], emit);
      expect(assembler.finish(emit).malformed).toHaveLength(1);
    });

    it('tolerates whitespace-padded arguments', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ index: 0, id: 'c1', function: { name: 'x', arguments: '  {"a":1}  ' } }], emit);
      expect(assembler.finish(emit).blocks[0].input).toEqual({ a: 1 });
    });
  });

  describe('empty stream', () => {
    it('reports no calls', () => {
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();
      expect(assembler.hasCalls).toBe(false);
      expect(assembler.finish(emit).blocks).toEqual([]);
    });

    it('drops a fragment that never produced a name', () => {
      // An id with no name is not a callable tool.
      const assembler = new ToolCallAssembler('test');
      const { emit } = collect();

      assembler.push([{ index: 0, id: 'c1', function: { arguments: '{}' } }], emit);
      expect(assembler.finish(emit).blocks).toEqual([]);
    });
  });
});
