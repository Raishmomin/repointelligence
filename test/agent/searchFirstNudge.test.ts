import { describe, expect, it } from 'vitest';
import { SEARCH_FIRST_NUDGE, shouldNudgeToSearch } from '../../src/layer3-reasoning/agent/AgentService';

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
