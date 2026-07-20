import { describe, expect, it } from 'vitest';
import { toolResultMessage } from '../../src/layer3-reasoning/agent/AgentService';
import { LlmToolResultBlock } from '../../src/layer3-reasoning/providers/types';

/**
 * Every `tool_use` block in an assistant turn must be answered by a `tool_result` in the
 * immediately following user message — all of them, in one message. An unanswered call is
 * an API error, and splitting results across messages trains the model out of parallel
 * tool use.
 *
 * This is the invariant approval parking is most likely to break, since a parked turn's
 * results arrive minutes apart and out of order.
 */

function blocksOf(message: ReturnType<typeof toolResultMessage>): LlmToolResultBlock[] {
  if (typeof message.content === 'string') throw new Error('expected structured content');
  return message.content as LlmToolResultBlock[];
}

describe('tool result pairing', () => {
  it('answers every tool call in one user message', () => {
    const message = toolResultMessage({
      toolUseIds: ['a', 'b', 'c'],
      resolved: {
        a: { content: 'result a' },
        b: { content: 'result b' },
        c: { content: 'result c' },
      },
      awaiting: {},
    });

    expect(message.role).toBe('user');
    expect(blocksOf(message)).toHaveLength(3);
  });

  it('preserves the original tool_use order regardless of resolution order', () => {
    // Approvals arrive in whatever order the user clicks, but the reply must match the
    // order the model emitted the calls in.
    const message = toolResultMessage({
      toolUseIds: ['first', 'second', 'third'],
      resolved: {
        third: { content: '3' },
        first: { content: '1' },
        second: { content: '2' },
      },
      awaiting: {},
    });

    expect(blocksOf(message).map((block) => block.toolUseId)).toEqual(['first', 'second', 'third']);
    expect(blocksOf(message).map((block) => block.content)).toEqual(['1', '2', '3']);
  });

  it('marks a rejected proposal as an error result rather than omitting it', () => {
    // Partial approval: 2 of 3 accepted. The rejected call still owes a result.
    const message = toolResultMessage({
      toolUseIds: ['edit1', 'edit2', 'edit3'],
      resolved: {
        edit1: { content: 'Applied: change A' },
        edit2: { content: 'The user rejected this change: change B', isError: true },
        edit3: { content: 'Applied: change C' },
      },
      awaiting: {},
    });

    const blocks = blocksOf(message);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].isError).toBe(true);
    expect(blocks[1].content).toMatch(/rejected/);
    expect(blocks[0].isError).toBeFalsy();
    expect(blocks[2].isError).toBeFalsy();
  });

  it('never omits a block, even when a result went missing', () => {
    // Should be unreachable, but an absent block is a hard API failure while a placeholder
    // is merely a confused turn — so this fails closed.
    const message = toolResultMessage({
      toolUseIds: ['a', 'ghost'],
      resolved: { a: { content: 'ok' } },
      awaiting: {},
    });

    const blocks = blocksOf(message);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].toolUseId).toBe('ghost');
    expect(blocks[1].isError).toBe(true);
  });

  it('handles a single tool call', () => {
    const message = toolResultMessage({
      toolUseIds: ['only'],
      resolved: { only: { content: 'done' } },
      awaiting: {},
    });
    expect(blocksOf(message)).toEqual([
      { type: 'tool_result', toolUseId: 'only', content: 'done', isError: undefined },
    ]);
  });

  it('preserves errors from auto-executed tools', () => {
    const message = toolResultMessage({
      toolUseIds: ['read', 'edit'],
      resolved: {
        read: { content: 'src/a.ts does not exist.', isError: true },
        edit: { content: 'Applied', isError: false },
      },
      awaiting: {},
    });

    const blocks = blocksOf(message);
    expect(blocks[0].isError).toBe(true);
    expect(blocks[1].isError).toBe(false);
  });

  it('produces every block as a tool_result', () => {
    const message = toolResultMessage({
      toolUseIds: ['a', 'b'],
      resolved: { a: { content: '1' }, b: { content: '2' } },
      awaiting: {},
    });
    expect(blocksOf(message).every((block) => block.type === 'tool_result')).toBe(true);
  });
});
