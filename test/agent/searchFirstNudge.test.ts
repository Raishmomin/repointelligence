import { describe, expect, it } from 'vitest';
import { responseForTextOnlyFinish, SEARCH_FIRST_NUDGE, shouldNudgeToSearch } from '../../src/layer3-reasoning/agent/AgentService';

/**
 * The reported failure: the agent replied "please provide me with the path of footer.ts"
 * instead of running glob. A text-only turn used to end the run outright, so the question
 * became the answer and nothing corrected it.
 */
describe('search-first nudge', () => {
  it('fires when the run is ending and nothing was ever searched', () => {
    expect(shouldNudgeToSearch({ discoveryToolsUsed: 0, nudgedToSearch: false })).toBe(true);
  });

  it('does not fire once the agent has searched', () => {
    // It looked and still has nothing to say — that is a legitimate ending.
    expect(shouldNudgeToSearch({ discoveryToolsUsed: 1, nudgedToSearch: false })).toBe(false);
  });

  it('does not fire twice in one run', () => {
    // Bounded, so a model that keeps refusing to search cannot spin the loop.
    expect(shouldNudgeToSearch({ discoveryToolsUsed: 0, nudgedToSearch: true })).toBe(false);
  });

  it('stays spent even if the count is still zero after the nudge', () => {
    const state = { discoveryToolsUsed: 0, nudgedToSearch: false };
    expect(shouldNudgeToSearch(state)).toBe(true);
    state.nudgedToSearch = true;
    expect(shouldNudgeToSearch(state)).toBe(false);
  });

  describe('the correction itself', () => {
    it('names the tools the agent should have used', () => {
      expect(SEARCH_FIRST_NUDGE).toContain('glob');
      expect(SEARCH_FIRST_NUDGE).toContain('grep');
      expect(SEARCH_FIRST_NUDGE).toContain('query_index');
    });

    it('tells the agent not to ask for a path', () => {
      expect(SEARCH_FIRST_NUDGE).toMatch(/do not ask the user for a path/i);
    });

    it('leaves an honest exit for a genuine dead end', () => {
      // Otherwise the agent is cornered into inventing a search that never happened.
      expect(SEARCH_FIRST_NUDGE).toMatch(/what you searched for/i);
    });
  });
});

describe('responseForTextOnlyFinish', () => {
  it('prefers the pre-nudge reply when the model merely acquiesces', () => {
    // The reported symptom: "hello" produced "Hello! How can I help you today?", the
    // nudge fired, and the recorded reply became "I understand. I will use the available
    // tools…" — the model answering the correction instead of the user.
    const response = responseForTextOnlyFinish(
      { turn: 2, nudgedAtTurn: 1, preNudgeText: 'Hello! How can I help you today?' },
      'I understand. I will use the available tools to search the repository.',
    );

    expect(response).toBe('Hello! How can I help you today?');
  });

  it('keeps the latest text when the nudge actually provoked a search', () => {
    // Turns advanced past nudge+1, so tools ran in between and the final text is a real
    // answer grounded in what they returned.
    const response = responseForTextOnlyFinish(
      { turn: 5, nudgedAtTurn: 1, preNudgeText: 'Hello!' },
      'Footer.tsx is at components/layout/Footer.tsx.',
    );

    expect(response).toBe('Footer.tsx is at components/layout/Footer.tsx.');
  });

  it('keeps the latest text when no nudge ever fired', () => {
    const response = responseForTextOnlyFinish({ turn: 3 }, 'Done — three files changed.');
    expect(response).toBe('Done — three files changed.');
  });

  it('falls back to the acquiescence when the pre-nudge turn had no text at all', () => {
    // Better a boilerplate reply than an empty one.
    const response = responseForTextOnlyFinish(
      { turn: 2, nudgedAtTurn: 1, preNudgeText: '' },
      'I understand. I will search.',
    );

    expect(response).toBe('I understand. I will search.');
  });
});

describe('silent final turn', () => {
  it('falls back to the last text any turn produced', () => {
    // The reported failure: "hello my name is jjj" — the model greeted alongside its
    // query_index call on turn 2, then had nothing to add after the results on turn 3.
    // The empty final text was recorded as the reply, so no bubble appeared at all.
    const response = responseForTextOnlyFinish(
      { turn: 3, nudgedAtTurn: 1, lastText: 'Hello jjj! Nice to meet you.' },
      '',
    );

    expect(response).toBe('Hello jjj! Nice to meet you.');
  });

  it('prefers the final text when there is one', () => {
    const response = responseForTextOnlyFinish(
      { turn: 3, nudgedAtTurn: 1, lastText: 'earlier commentary' },
      'The footer is at components/layout/Footer.tsx.',
    );

    expect(response).toBe('The footer is at components/layout/Footer.tsx.');
  });

  it('returns empty only when the whole run said nothing', () => {
    expect(responseForTextOnlyFinish({ turn: 2 }, '')).toBe('');
  });
});
