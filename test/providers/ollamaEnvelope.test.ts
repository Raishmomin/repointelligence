import { describe, expect, it } from 'vitest';
import { describeToolsForPrompt, parseOllamaEnvelope } from '../../src/layer3-reasoning/providers/ollamaEnvelope';

const TOOLS = ['read_file', 'str_replace', 'grep'];

describe('parseOllamaEnvelope', () => {
  describe('well-formed envelopes', () => {
    it('parses text and a tool call', () => {
      const { blocks, hasToolCalls } = parseOllamaEnvelope(
        '{"response":"Reading the file.","toolCalls":[{"id":"a1","name":"read_file","arguments":{"path":"src/a.ts"}}]}',
        TOOLS,
      );
      expect(hasToolCalls).toBe(true);
      expect(blocks).toEqual([
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 'a1', name: 'read_file', input: { path: 'src/a.ts' } },
      ]);
    });

    it('parses a text-only response', () => {
      const { blocks, hasToolCalls } = parseOllamaEnvelope('{"response":"All done."}', TOOLS);
      expect(hasToolCalls).toBe(false);
      expect(blocks).toEqual([{ type: 'text', text: 'All done.' }]);
    });

    it('parses multiple parallel tool calls', () => {
      const { blocks } = parseOllamaEnvelope(
        '{"toolCalls":[{"id":"1","name":"read_file","arguments":{"path":"a.ts"}},{"id":"2","name":"grep","arguments":{"pattern":"foo"}}]}',
        TOOLS,
      );
      expect(blocks).toHaveLength(2);
      expect(blocks.map((b) => (b.type === 'tool_use' ? b.name : b.type))).toEqual(['read_file', 'grep']);
    });

    it('accepts a tool call with no arguments', () => {
      const { blocks } = parseOllamaEnvelope('{"toolCalls":[{"id":"1","name":"grep"}]}', TOOLS);
      expect(blocks).toEqual([{ type: 'tool_use', id: '1', name: 'grep', input: {} }]);
    });

    it('unwraps double-encoded arguments', () => {
      // Small models frequently emit arguments as a JSON string rather than an object.
      const { blocks } = parseOllamaEnvelope(
        '{"toolCalls":[{"id":"1","name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}]}',
        TOOLS,
      );
      expect(blocks).toEqual([{ type: 'tool_use', id: '1', name: 'read_file', input: { path: 'a.ts' } }]);
    });

    it('recovers JSON wrapped in a markdown fence', () => {
      const { blocks, hasToolCalls } = parseOllamaEnvelope(
        'Sure!\n```json\n{"response":"hi"}\n```\n',
        TOOLS,
      );
      expect(hasToolCalls).toBe(false);
      expect(blocks).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('assigns positional ids when the model omits them', () => {
      const { blocks } = parseOllamaEnvelope(
        '{"toolCalls":[{"name":"read_file","arguments":{"path":"a.ts"}},{"name":"grep","arguments":{"pattern":"x"}}]}',
        TOOLS,
      );
      // Distinct ids matter: tool_use and tool_result are paired by them.
      expect(blocks.map((b) => (b.type === 'tool_use' ? b.id : ''))).toEqual(['call_0', 'call_1']);
    });
  });

  describe('never fabricates tool calls', () => {
    it('degrades malformed JSON to text', () => {
      const { blocks, hasToolCalls } = parseOllamaEnvelope('not json at all', TOOLS);
      expect(hasToolCalls).toBe(false);
      expect(blocks).toEqual([{ type: 'text', text: 'not json at all' }]);
    });

    it('degrades truncated JSON to text', () => {
      const raw = '{"response":"partial","toolCalls":[{"id":"1","name":"read_file","argu';
      const { hasToolCalls } = parseOllamaEnvelope(raw, TOOLS);
      expect(hasToolCalls).toBe(false);
    });

    it('drops a tool the model invented', () => {
      const { blocks, hasToolCalls } = parseOllamaEnvelope(
        '{"response":"ok","toolCalls":[{"id":"1","name":"rm_rf","arguments":{"path":"/"}}]}',
        TOOLS,
      );
      expect(hasToolCalls).toBe(false);
      expect(blocks).toEqual([{ type: 'text', text: 'ok' }]);
    });

    it('drops a call whose arguments are not an object', () => {
      const { hasToolCalls } = parseOllamaEnvelope(
        '{"response":"ok","toolCalls":[{"id":"1","name":"read_file","arguments":"src/a.ts"}]}',
        TOOLS,
      );
      expect(hasToolCalls).toBe(false);
    });

    it('drops non-object entries in the toolCalls array', () => {
      const { hasToolCalls } = parseOllamaEnvelope(
        '{"response":"ok","toolCalls":["read_file",null,42]}',
        TOOLS,
      );
      expect(hasToolCalls).toBe(false);
    });

    it('keeps valid calls alongside invalid ones', () => {
      const { blocks, hasToolCalls } = parseOllamaEnvelope(
        '{"toolCalls":[{"id":"1","name":"nope","arguments":{}},{"id":"2","name":"grep","arguments":{"pattern":"x"}}]}',
        TOOLS,
      );
      expect(hasToolCalls).toBe(true);
      expect(blocks).toEqual([{ type: 'tool_use', id: '2', name: 'grep', input: { pattern: 'x' } }]);
    });

    it('treats a bare JSON array as text', () => {
      const { hasToolCalls, blocks } = parseOllamaEnvelope('[1,2,3]', TOOLS);
      expect(hasToolCalls).toBe(false);
      expect(blocks).toEqual([{ type: 'text', text: '[1,2,3]' }]);
    });

    it('returns no blocks for empty output', () => {
      expect(parseOllamaEnvelope('   ', TOOLS)).toEqual({ blocks: [], hasToolCalls: false });
    });

    it('falls back to raw text when the object parses but yields nothing', () => {
      const { blocks } = parseOllamaEnvelope('{"unexpected":"shape"}', TOOLS);
      expect(blocks).toEqual([{ type: 'text', text: '{"unexpected":"shape"}' }]);
    });
  });
});

describe('describeToolsForPrompt', () => {
  it('returns empty string when there are no tools', () => {
    expect(describeToolsForPrompt([])).toBe('');
  });

  it('sorts tools by name so the cached prefix stays stable', () => {
    const description = describeToolsForPrompt([
      { name: 'zebra', description: 'z', inputSchema: {} },
      { name: 'alpha', description: 'a', inputSchema: {} },
    ]);
    expect(description.indexOf('alpha')).toBeLessThan(description.indexOf('zebra'));
  });

  it('is deterministic across calls with reordered input', () => {
    const a = describeToolsForPrompt([
      { name: 'one', description: 'first', inputSchema: { type: 'object' } },
      { name: 'two', description: 'second', inputSchema: { type: 'object' } },
    ]);
    const b = describeToolsForPrompt([
      { name: 'two', description: 'second', inputSchema: { type: 'object' } },
      { name: 'one', description: 'first', inputSchema: { type: 'object' } },
    ]);
    expect(a).toBe(b);
  });
});
