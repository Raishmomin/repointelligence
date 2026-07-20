/**
 * Server-Sent Events reader for OpenAI-compatible `/chat/completions` streams.
 *
 * Two details here are easy to get wrong and fail only intermittently:
 *
 *  - Events are separated by a **blank line** (`\n\n`), not a newline. Splitting on `\n`
 *    happens to work whenever a chunk lands on an event boundary, and produces truncated
 *    JSON when it does not — so it passes in testing and fails under load.
 *  - `TextDecoder.decode` must be called with `{ stream: true }`. Without it, a multi-byte
 *    UTF-8 character split across two network chunks decodes to U+FFFD. In this codebase
 *    that corruption lands inside source code the model is editing.
 */

export interface SseEvent {
  data: string;
}

/**
 * Yields one event per SSE frame, skipping comments and blank frames. Terminates on the
 * `[DONE]` sentinel.
 */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal?: { isCancellationRequested: boolean },
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.isCancellationRequested) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Normalise CRLF so a proxy that rewrites line endings does not break framing.
      buffer = buffer.replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const event = parseFrame(frame);
        if (event === DONE) return;
        if (event) yield event;

        boundary = buffer.indexOf('\n\n');
      }
    }

    // Flush whatever the decoder is still holding, then any final unterminated frame —
    // some servers close without a trailing blank line.
    buffer += decoder.decode();
    const event = parseFrame(buffer.replace(/\r\n/g, '\n'));
    if (event && event !== DONE) yield event;
  } finally {
    // Releasing matters on cancellation: without it the underlying socket can stay open.
    reader.releaseLock();
  }
}

const DONE = Symbol('sse-done');

function parseFrame(frame: string): SseEvent | typeof DONE | undefined {
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    // Comments (`: keep-alive`) and non-data fields are not used by this API.
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).trimStart());
  }

  if (!dataLines.length) return undefined;

  // Multi-line data fields are joined with newlines per the SSE spec.
  const data = dataLines.join('\n');
  if (data === '[DONE]') return DONE;
  return { data };
}

/** Parses a frame's JSON, returning undefined rather than throwing on a malformed one. */
export function parseChunk<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}
