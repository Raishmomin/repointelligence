import { describe, expect, it } from 'vitest';
import { TranscriptManager } from '../../src/layer3-reasoning/agent/TranscriptManager';
import { LlmMessage } from '../../src/layer3-reasoning/providers/types';

/**
 * A run parked for approval re-resolves its provider when it resumes, so the backend can
 * change underneath it — the user switches provider, or a fallback kicks in.
 *
 * The transcript replays provider-native assistant blocks verbatim. Anthropic thinking
 * blocks carry signatures tied to the model that produced them, and tool-call ids are
 * minted by the provider. Replaying those into a different backend is a correctness
 * problem, so the run is refused rather than resumed.
 *
 * This exercises the same predicate the guard uses, over a real TranscriptManager.
 */
function hasProviderNativeBlocks(transcript: TranscriptManager): boolean {
  return transcript
    .all()
    .some(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'thinking' || block.type === 'tool_use'),
    );
}

function build(messages: LlmMessage[]): TranscriptManager {
  const transcript = new TranscriptManager(100_000);
  transcript.replaceAll(messages);
  return transcript;
}

describe('provider switch on resume', () => {
  describe('transcripts that cannot be replayed elsewhere', () => {
    it('detects thinking blocks', () => {
      // Signed by the model that produced them; another backend cannot honour them.
      expect(
        hasProviderNativeBlocks(
          build([
            { role: 'user', content: 'do the thing' },
            { role: 'assistant', content: [{ type: 'thinking', text: 'considering…' }] },
          ]),
        ),
      ).toBe(true);
    });

    it('detects tool calls', () => {
      // Tool-use ids are provider-minted, and their results are paired against them.
      expect(
        hasProviderNativeBlocks(
          build([
            { role: 'user', content: 'do the thing' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a.ts' } }],
            },
          ]),
        ),
      ).toBe(true);
    });

    it('detects them alongside ordinary text', () => {
      expect(
        hasProviderNativeBlocks(
          build([
            { role: 'user', content: 'do the thing' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Reading the file.' },
                { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: {} },
              ],
            },
          ]),
        ),
      ).toBe(true);
    });

    it('detects them deep in a long transcript', () => {
      const messages: LlmMessage[] = [{ role: 'user', content: 'start' }];
      for (let index = 0; index < 20; index++) {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: `turn ${index}` }] });
      }
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_late', name: 'grep', input: {} }],
      });
      expect(hasProviderNativeBlocks(build(messages))).toBe(true);
    });
  });

  describe('transcripts that are portable', () => {
    it('allows a text-only conversation', () => {
      // Nothing provider-specific here, so switching backend mid-run is harmless.
      expect(
        hasProviderNativeBlocks(
          build([
            { role: 'user', content: 'what does this repo do?' },
            { role: 'assistant', content: [{ type: 'text', text: 'It indexes a codebase.' }] },
          ]),
        ),
      ).toBe(false);
    });

    it('allows an empty transcript', () => {
      expect(hasProviderNativeBlocks(build([]))).toBe(false);
    });

    it('ignores tool_result blocks, which live on user turns', () => {
      // A tool_result alone is plain content; it is the assistant's tool_use that is bound
      // to the provider.
      expect(
        hasProviderNativeBlocks(
          build([
            { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'file contents' }] },
          ]),
        ),
      ).toBe(false);
    });

    it('ignores a plain string user turn', () => {
      expect(hasProviderNativeBlocks(build([{ role: 'user', content: 'hello' }]))).toBe(false);
    });
  });
});
