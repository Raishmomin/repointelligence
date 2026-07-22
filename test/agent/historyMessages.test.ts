import { describe, expect, it } from 'vitest';
import { historyMessages } from '../../src/layer3-reasoning/agent/AgentService';

/**
 * Every run previously started from the prompt alone — "what is my name?" one message
 * after stating it could not work, and a mid-chat model switch was blamed for a memory
 * that never existed. These pin the budget walk that fixes it.
 */
describe('historyMessages', () => {
  const exchange = (i: number) =>
    [
      { role: 'user' as const, content: `question ${i}` },
      { role: 'assistant' as const, content: `answer ${i}` },
    ];

  it('replays prior exchanges in order', () => {
    const kept = historyMessages([...exchange(1), ...exchange(2)], 10_000);

    expect(kept.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(kept[0].content).toBe('question 1');
  });

  it('wraps assistant text in a content block, the shape every provider renders', () => {
    const [, assistant] = historyMessages(exchange(1), 10_000);

    expect(assistant).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer 1' }],
    });
  });

  it('keeps the newest messages when the budget is tight', () => {
    // ~4 chars per token; each filler message costs ~25 tokens. A 60-token budget fits
    // the last two whole messages and must drop from the old end, not the new.
    const old = { role: 'user' as const, content: 'x'.repeat(100) };
    const mid = { role: 'assistant' as const, content: 'y'.repeat(100) };
    const recent = { role: 'user' as const, content: 'z'.repeat(100) };

    const kept = historyMessages([old, mid, recent], 60);

    expect(kept).toHaveLength(2);
    expect(kept[0].content).toEqual([{ type: 'text', text: 'y'.repeat(100) }]);
    expect(kept[1].content).toBe('z'.repeat(100));
  });

  it('keeps whole messages only — never a truncated middle of an old one', () => {
    const kept = historyMessages(
      [
        { role: 'user', content: 'a'.repeat(1000) },
        { role: 'assistant', content: 'short' },
      ],
      50,
    );

    // The big message does not fit; the walk stops rather than slicing it.
    expect(kept).toHaveLength(1);
    expect(kept[0].role).toBe('assistant');
  });

  it('returns nothing when history is disabled', () => {
    expect(historyMessages(exchange(1), 0)).toEqual([]);
  });

  it('returns nothing for an empty session', () => {
    expect(historyMessages([], 4000)).toEqual([]);
  });
});
