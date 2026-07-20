import { describe, expect, it } from 'vitest';
import { TranscriptManager } from '../../src/layer3-reasoning/agent/TranscriptManager';
import { LlmMessage } from '../../src/layer3-reasoning/providers/types';

const user = (text: string): LlmMessage => ({ role: 'user', content: text });
const assistantText = (text: string): LlmMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
const assistantToolUse = (id: string): LlmMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'a.ts' } }],
});
const toolResult = (id: string): LlmMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content: 'file contents' }],
});

describe('TranscriptManager', () => {
  describe('token estimation', () => {
    it('counts text content', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(user('a'.repeat(400)));
      expect(transcript.estimatedTokens()).toBe(100);
    });

    it('counts tool inputs and results, not just text', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(assistantToolUse('x'));
      transcript.push(toolResult('x'));
      expect(transcript.estimatedTokens()).toBeGreaterThan(0);
    });

    it('starts empty', () => {
      expect(new TranscriptManager(1000).estimatedTokens()).toBe(0);
    });
  });

  describe('compaction threshold', () => {
    it('does not compact a short transcript', () => {
      const transcript = new TranscriptManager(10_000);
      transcript.push(user('short'));
      expect(transcript.shouldCompact()).toBe(false);
    });

    it('compacts once past 70% of the context window', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(user('a'.repeat(3000))); // ~750 tokens
      expect(transcript.shouldCompact()).toBe(true);
    });
  });

  describe('compaction preserves tool_use/tool_result pairing', () => {
    it('never leaves a tool_result whose tool_use was dropped', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(user('task'));
      for (let index = 0; index < 10; index++) {
        transcript.push(assistantToolUse(`call${index}`));
        transcript.push(toolResult(`call${index}`));
      }

      transcript.compact(4);

      const messages = transcript.all();
      const answeredIds = new Set<string>();
      for (const message of messages) {
        if (message.role === 'assistant' && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'tool_use') answeredIds.add(block.id);
          }
        }
      }

      for (const message of messages) {
        if (message.role === 'user' && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'tool_result') {
              // An orphaned tool_result — one whose tool_use was compacted away — is a
              // hard API error.
              expect(answeredIds.has(block.toolUseId)).toBe(true);
            }
          }
        }
      }
    });

    it('keeps the opening turn, which carries the task', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(user('the original task'));
      for (let index = 0; index < 12; index++) transcript.push(assistantText(`turn ${index}`));

      transcript.compact(4);
      expect(transcript.all()[0]).toEqual(user('the original task'));
    });

    it('keeps the most recent turns', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(user('task'));
      for (let index = 0; index < 12; index++) transcript.push(assistantText(`turn ${index}`));

      transcript.compact(4);
      const last = transcript.all().at(-1);
      expect(last).toEqual(assistantText('turn 11'));
    });

    it('tells the model what it lost', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(user('task'));
      for (let index = 0; index < 12; index++) transcript.push(assistantText(`turn ${index}`));

      transcript.compact(4);
      const notice = transcript.all()[1];
      expect(typeof notice.content === 'string' && notice.content).toMatch(/removed/i);
      // Files read before the cut may no longer be visible; the model must re-read.
      expect(typeof notice.content === 'string' && notice.content).toMatch(/read them again/i);
    });

    it('reports how many messages were removed', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(user('task'));
      for (let index = 0; index < 12; index++) transcript.push(assistantText(`turn ${index}`));

      expect(transcript.compact(4)).toBeGreaterThan(0);
    });

    it('does nothing when there is too little to drop', () => {
      const transcript = new TranscriptManager(1000);
      transcript.push(user('task'));
      transcript.push(assistantText('reply'));

      expect(transcript.compact(6)).toBe(0);
      expect(transcript.length).toBe(2);
    });
  });

  describe('replaceAll', () => {
    it('restores a persisted transcript, as after a park and resume', () => {
      const transcript = new TranscriptManager(1000);
      const restored = [user('task'), assistantToolUse('x'), toolResult('x')];
      transcript.replaceAll(restored);
      expect(transcript.all()).toEqual(restored);
    });

    it('copies rather than aliasing the source array', () => {
      const transcript = new TranscriptManager(1000);
      const source = [user('task')];
      transcript.replaceAll(source);
      source.push(user('added later'));
      expect(transcript.length).toBe(1);
    });
  });
});
