import { describe, expect, it } from 'vitest';
import {
  mapFinishReason,
  OpenAICompatProvider,
  toOpenAIMessages,
  toOpenAITools,
} from '../../src/layer3-reasoning/providers/openai-compat/OpenAICompatProvider';
import {
  sanitizeSchema,
  splitThinkTags,
  vendorById,
  VENDORS,
} from '../../src/layer3-reasoning/providers/openai-compat/vendors';
import { OPENAI_COMPAT_DESCRIPTORS } from '../../src/layer3-reasoning/providers/openai-compat/descriptors';
import { ProviderRegistry } from '../../src/layer3-reasoning/providers/ProviderRegistry';
import { LlmMessage } from '../../src/layer3-reasoning/providers/types';

describe('mapFinishReason', () => {
  it('maps the ordinary reasons', () => {
    expect(mapFinishReason('stop', false)).toBe('end_turn');
    expect(mapFinishReason('tool_calls', false)).toBe('tool_use');
    expect(mapFinishReason('length', false)).toBe('max_tokens');
    expect(mapFinishReason('content_filter', false)).toBe('refusal');
  });

  it('treats "stop" with tool calls present as tool_use', () => {
    // Groq and several Nvidia models report "stop" alongside tool calls. Trusting it ends
    // the turn with the tools never executed, which reads as the agent giving up mid-task.
    expect(mapFinishReason('stop', true)).toBe('tool_use');
  });

  it('treats a missing finish_reason with tool calls as tool_use', () => {
    expect(mapFinishReason(undefined, true)).toBe('tool_use');
  });

  it('defaults an unknown reason to end_turn', () => {
    expect(mapFinishReason('something_new', false)).toBe('end_turn');
  });
});

describe('toOpenAIMessages', () => {
  it('puts the system prompt first', () => {
    const out = toOpenAIMessages('be helpful', []);
    expect(out[0]).toEqual({ role: 'system', content: 'be helpful' });
  });

  it('fans tool results out into separate role:tool messages', () => {
    // Nesting them in a user turn is accepted by some vendors and silently ignored by
    // others, which loses the tool output with no error.
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'c1', content: 'file A' },
          { type: 'tool_result', toolUseId: 'c2', content: 'file B' },
        ],
      },
    ];

    expect(toOpenAIMessages('s', messages).slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'file A' },
      { role: 'tool', tool_call_id: 'c2', content: 'file B' },
    ]);
  });

  it('emits tool results before any accompanying user text', () => {
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'c1', content: 'result' },
          { type: 'text', text: 'now do the next bit' },
        ],
      },
    ];

    const roles = toOpenAIMessages('s', messages).slice(1).map((m) => m.role);
    expect(roles).toEqual(['tool', 'user']);
  });

  it('serialises assistant tool calls into the tool_calls field', () => {
    const messages: LlmMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
    ];

    expect(toOpenAIMessages('s', messages)[1]).toEqual({
      role: 'assistant',
      content: 'Reading it.',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
      ],
    });
  });

  it('sends null rather than an empty string alongside tool calls', () => {
    // Some vendors reject content:"" when tool_calls is present.
    const messages: LlmMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }] },
    ];
    expect(toOpenAIMessages('s', messages)[1].content).toBeNull();
  });

  it('passes a plain string user turn through', () => {
    expect(toOpenAIMessages('s', [{ role: 'user', content: 'hello' }])[1]).toEqual({
      role: 'user',
      content: 'hello',
    });
  });

  it('drops thinking blocks, which have no representation in this dialect', () => {
    const messages: LlmMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'internal' },
          { type: 'text', text: 'visible' },
        ],
      },
    ];
    expect(toOpenAIMessages('s', messages)[1].content).toBe('visible');
  });
});

describe('toOpenAITools', () => {
  const tools = [
    { name: 'zebra', description: 'z', inputSchema: { type: 'object', additionalProperties: false } },
    { name: 'alpha', description: 'a', inputSchema: { type: 'object' } },
  ];

  it('sorts by name for a stable request shape', () => {
    const openai = vendorById('openai')!;
    expect(toOpenAITools(tools, openai).map((t) => (t.function as { name: string }).name)).toEqual([
      'alpha',
      'zebra',
    ]);
  });

  it('leaves schemas intact for vendors that accept them', () => {
    const openai = vendorById('openai')!;
    const zebra = toOpenAITools(tools, openai).find(
      (t) => (t.function as { name: string }).name === 'zebra',
    );
    expect((zebra!.function as { parameters: Record<string, unknown> }).parameters).toHaveProperty(
      'additionalProperties',
    );
  });

  it('strips unsupported keywords for Gemini', () => {
    // Gemini rejects the request outright rather than ignoring the field.
    const gemini = vendorById('gemini')!;
    const zebra = toOpenAITools(tools, gemini).find(
      (t) => (t.function as { name: string }).name === 'zebra',
    );
    expect((zebra!.function as { parameters: Record<string, unknown> }).parameters).not.toHaveProperty(
      'additionalProperties',
    );
  });
});

describe('sanitizeSchema', () => {
  it('removes the keywords Gemini rejects, at any depth', () => {
    const cleaned = sanitizeSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: {
        nested: { type: 'object', additionalProperties: false, default: 'x' },
      },
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty('additionalProperties');
    expect(cleaned).not.toHaveProperty('$schema');
    expect((cleaned.properties as Record<string, Record<string, unknown>>).nested).toEqual({
      type: 'object',
    });
  });

  it('preserves everything else', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(sanitizeSchema(schema)).toEqual(schema);
  });

  it('recurses into arrays', () => {
    expect(sanitizeSchema({ anyOf: [{ type: 'string', default: 'x' }] })).toEqual({
      anyOf: [{ type: 'string' }],
    });
  });
});

describe('splitThinkTags', () => {
  it('separates reasoning from the answer', () => {
    expect(splitThinkTags('<think>weighing it up</think>The answer.')).toEqual({
      thinking: 'weighing it up',
      content: 'The answer.',
    });
  });

  it('handles multiple blocks', () => {
    const { thinking, content } = splitThinkTags('<think>a</think>X<think>b</think>Y');
    expect(thinking).toBe('ab');
    expect(content).toBe('XY');
  });

  it('leaves plain text alone', () => {
    expect(splitThinkTags('just an answer')).toEqual({ thinking: '', content: 'just an answer' });
  });
});

describe('vendor descriptors', () => {
  it('registers all five vendors', () => {
    expect(OPENAI_COMPAT_DESCRIPTORS.map((d) => d.id).sort()).toEqual([
      'gemini',
      'groq',
      'nvidia',
      'openai',
      'openrouter',
    ]);
  });

  it('gives each vendor its own secret key, so keys never collide', () => {
    const keys = VENDORS.map((v) => v.secretKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares no embedding capability', () => {
    // Enabling it would write incompatible-dimension vectors into the existing index.
    for (const descriptor of OPENAI_COMPAT_DESCRIPTORS) {
      expect(descriptor.capabilities.embeddings).toBe(false);
      expect(descriptor.createEmbedder).toBeUndefined();
    }
  });

  it('declares native tool calling', () => {
    for (const descriptor of OPENAI_COMPAT_DESCRIPTORS) {
      expect(descriptor.capabilities.nativeTools).toBe(true);
    }
  });

  it('gives every vendor an api key, base url and model field', () => {
    for (const descriptor of OPENAI_COMPAT_DESCRIPTORS) {
      const ids = descriptor.fields.map((f) => f.id);
      expect(ids).toContain('apiKey');
      expect(ids).toContain('baseUrl');
      expect(ids).toContain('model');
    }
  });

  it('joins the real registry without collisions and ranks below Anthropic', () => {
    const registry = new ProviderRegistry();
    expect(registry.ids()).toHaveLength(7);

    const ranked = registry.byFallbackRank().map((d) => d.id);
    expect(ranked[0]).toBe('anthropic');
    expect(ranked.at(-1)).toBe('ollama');
  });
});

describe('OpenAI max-tokens field', () => {
  it('uses max_completion_tokens for reasoning models', () => {
    // Sending both fields is a 400.
    const openai = vendorById('openai')!;
    expect(openai.maxTokensField!('o1-preview')).toBe('max_completion_tokens');
    expect(openai.maxTokensField!('gpt-5-turbo')).toBe('max_completion_tokens');
  });

  it('uses max_tokens otherwise', () => {
    const openai = vendorById('openai')!;
    expect(openai.maxTokensField!('gpt-4o')).toBe('max_tokens');
  });
});

describe('model filters', () => {
  it('drops non-chat OpenAI models', () => {
    const openai = vendorById('openai')!;
    expect(openai.filterModels!({ id: 'gpt-4o' })).toBe(true);
    expect(openai.filterModels!({ id: 'text-embedding-3-small' })).toBe(false);
    expect(openai.filterModels!({ id: 'whisper-1' })).toBe(false);
  });

  it('keeps only tool-capable OpenRouter models', () => {
    // Unfiltered this returns hundreds of entries and the dropdown is unusable.
    const openrouter = vendorById('openrouter')!;
    expect(openrouter.filterModels!({ id: 'a', supported_parameters: ['tools'] })).toBe(true);
    expect(openrouter.filterModels!({ id: 'b', supported_parameters: ['temperature'] })).toBe(false);
    expect(openrouter.filterModels!({ id: 'c' })).toBe(false);
  });
});

describe('stream_options', () => {
  const CONFIG = {
    get: () => undefined,
    getString: (_id: string, fallback = '') => fallback,
    getNumber: (_id: string, fallback: number) => fallback,
    getSecret: async () => 'test-key',
  };

  const LOGGER = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  /** An SSE stream carrying one usage frame, which is what include_usage buys. */
  function sseResponse(body: string, status = 200): Response {
    return new Response(status === 200 ? body : '{"error":{"message":"x"}}', {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  const DONE =
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
    'data: {"usage":{"prompt_tokens":11,"completion_tokens":22},"choices":[]}\n\n' +
    'data: [DONE]\n\n';

  function turnRequest() {
    return {
      system: 'sys',
      messages: [{ role: 'user' as const, content: 'hello' }],
      tools: [],
      maxTokens: 100,
      token: { isCancellationRequested: false },
      onEvent: () => {},
    };
  }

  async function bodiesFor(vendorId: string, responses: Response[]) {
    const sent: Record<string, unknown>[] = [];
    const original = globalThis.fetch;
    let call = 0;

    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return responses[Math.min(call++, responses.length - 1)];
    }) as typeof fetch;

    try {
      const provider = new OpenAICompatProvider(vendorById(vendorId)!, CONFIG as never, LOGGER as never);
      await provider.streamTurn(turnRequest() as never).catch(() => undefined);
    } finally {
      globalThis.fetch = original;
    }

    return sent;
  }

  it('asks for usage, without which a streamed response reports no tokens at all', async () => {
    // The observed symptom was every Gemini run showing "0 in, 0 out": the provider read
    // chunk.usage but never requested it, so no usage frame was ever sent.
    const [body] = await bodiesFor('openai', [sseResponse(DONE)]);

    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('retries without the field when an endpoint rejects it', async () => {
    // Gemini already rejects parallel_tool_calls outright rather than ignoring it, so an
    // endpoint refusing stream_options is a real possibility. Losing token counts is an
    // acceptable outcome; losing the provider is not.
    const rejection = new Response('{"error":{"message":"Unknown name \\"stream_options\\""}}', {
      status: 400,
    });
    const bodies = await bodiesFor('gemini', [rejection, sseResponse(DONE)]);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    expect(bodies[1].stream_options).toBeUndefined();
  });

  it('does not retry a 400 that is about something else', async () => {
    const unrelated = new Response('{"error":{"message":"context length exceeded"}}', { status: 400 });
    const bodies = await bodiesFor('openai', [unrelated]);

    expect(bodies).toHaveLength(1);
  });
});
