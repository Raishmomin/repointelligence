import { describe, expect, it } from 'vitest';
import { parseChunk, readSSE } from '../../src/layer3-reasoning/providers/openai-compat/sse';

/** Builds a stream that delivers exactly the given byte chunks, to control split points. */
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const event of readSSE(stream)) out.push(event.data);
  return out;
}

describe('readSSE', () => {
  describe('framing', () => {
    it('reads events separated by a blank line', async () => {
      expect(await collect(streamOf(['data: {"a":1}\n\ndata: {"a":2}\n\n']))).toEqual([
        '{"a":1}',
        '{"a":2}',
      ]);
    });

    it('reassembles an event split across chunk boundaries', async () => {
      // The realistic case: the network splits mid-JSON.
      expect(await collect(streamOf(['data: {"a"', ':1}\n\n']))).toEqual(['{"a":1}']);
    });

    it('handles a split exactly on the event separator', async () => {
      expect(await collect(streamOf(['data: {"a":1}\n', '\ndata: {"a":2}\n\n']))).toEqual([
        '{"a":1}',
        '{"a":2}',
      ]);
    });

    it('does not split on a single newline inside a frame', async () => {
      // Splitting on \n instead of \n\n truncates JSON — and only under some chunkings,
      // which is why it passes in testing and fails in production.
      expect(await collect(streamOf(['data: {"a":1}\ndata: {"b":2}\n\n']))).toEqual([
        '{"a":1}\n{"b":2}',
      ]);
    });

    it('stops at the [DONE] sentinel', async () => {
      expect(await collect(streamOf(['data: {"a":1}\n\ndata: [DONE]\n\ndata: {"never":1}\n\n']))).toEqual([
        '{"a":1}',
      ]);
    });

    it('yields a final frame that has no trailing blank line', async () => {
      // Some servers close the connection without terminating the last event.
      expect(await collect(streamOf(['data: {"a":1}']))).toEqual(['{"a":1}']);
    });

    it('skips comment frames used as keep-alives', async () => {
      expect(await collect(streamOf([': keep-alive\n\ndata: {"a":1}\n\n']))).toEqual(['{"a":1}']);
    });

    it('tolerates CRLF line endings from a rewriting proxy', async () => {
      expect(await collect(streamOf(['data: {"a":1}\r\n\r\n']))).toEqual(['{"a":1}']);
    });

    it('returns nothing for an empty stream', async () => {
      expect(await collect(streamOf([]))).toEqual([]);
    });
  });

  describe('UTF-8 across chunk boundaries', () => {
    it('does not corrupt a multi-byte character split between chunks', async () => {
      // Without { stream: true } this becomes U+FFFD — and in this codebase that
      // corruption lands inside source the model is editing.
      const payload = 'data: {"text":"café — 日本語"}\n\n';
      const bytes = new TextEncoder().encode(payload);

      // Split mid-character: the em dash is 3 bytes.
      const splitAt = payload.indexOf('—') + 1;
      const events = await collect(streamOf([bytes.slice(0, splitAt), bytes.slice(splitAt)]));

      expect(events[0]).toBe('{"text":"café — 日本語"}');
      expect(events[0]).not.toContain('�');
    });

    it('survives a byte-at-a-time stream', async () => {
      const payload = 'data: {"text":"日本語"}\n\n';
      const bytes = new TextEncoder().encode(payload);
      const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));

      expect(await collect(streamOf(chunks))).toEqual(['{"text":"日本語"}']);
    });
  });

  describe('cancellation', () => {
    it('stops reading when the token is already cancelled', async () => {
      const token = { isCancellationRequested: true };
      const out: string[] = [];
      for await (const event of readSSE(streamOf(['data: {"a":1}\n\n']), token)) out.push(event.data);
      expect(out).toEqual([]);
    });
  });
});

describe('parseChunk', () => {
  it('parses valid JSON', () => {
    expect(parseChunk<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined rather than throwing on malformed JSON', () => {
    // One bad frame must not abort an otherwise healthy stream.
    expect(parseChunk('{"a"')).toBeUndefined();
  });
});
