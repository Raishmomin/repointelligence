import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MODELS,
  capabilitiesFor,
  isKnownModel,
  thinkingParamsFor,
} from '../../src/layer3-reasoning/providers/modelCapabilities';

/**
 * These models reject each other's parameters with HTTP 400 rather than warnings, so the
 * divergences are pinned here. If a future model is added, these tests are what catch a
 * shared request builder silently sending it something it rejects.
 */
describe('model capability table', () => {
  describe('Opus 4.8', () => {
    const model = ANTHROPIC_MODELS.opus;

    it('uses adaptive thinking with summarized display', () => {
      // The default display is "omitted", which streams empty thinking text — the UI
      // would show a silent pause instead of reasoning.
      expect(thinkingParamsFor(model, 'high', 64_000).thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
    });

    it('sends effort', () => {
      expect(thinkingParamsFor(model, 'xhigh', 64_000).output_config).toEqual({ effort: 'xhigh' });
    });

    it('never sends budget_tokens', () => {
      const thinking = thinkingParamsFor(model, 'high', 64_000).thinking as Record<string, unknown>;
      expect(thinking).not.toHaveProperty('budget_tokens');
    });

    it('does not think unless thinking is set explicitly', () => {
      expect(capabilitiesFor(model).thinkingOnByDefault).toBe(false);
    });

    it('rejects sampling parameters', () => {
      expect(capabilitiesFor(model).samplingParams).toBe(false);
    });
  });

  describe('Sonnet 5', () => {
    const model = ANTHROPIC_MODELS.sonnet;

    it('uses adaptive thinking and effort', () => {
      const params = thinkingParamsFor(model, 'medium', 32_000);
      expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(params.output_config).toEqual({ effort: 'medium' });
    });

    it('thinks by default, unlike Opus 4.8', () => {
      expect(capabilitiesFor(model).thinkingOnByDefault).toBe(true);
      expect(capabilitiesFor(ANTHROPIC_MODELS.opus).thinkingOnByDefault).toBe(false);
    });
  });

  describe('Haiku 4.5 — the outlier', () => {
    const model = ANTHROPIC_MODELS.haiku;

    it('uses budget_tokens instead of adaptive thinking', () => {
      const thinking = thinkingParamsFor(model, 'high', 32_000).thinking as Record<string, unknown>;
      expect(thinking.type).toBe('enabled');
      expect(thinking.budget_tokens).toBeTypeOf('number');
    });

    it('never sends effort, which it rejects outright', () => {
      expect(thinkingParamsFor(model, 'high', 32_000)).not.toHaveProperty('output_config');
    });

    it('keeps budget_tokens strictly below max_tokens', () => {
      for (const maxTokens of [4096, 16_000, 32_000, 64_000]) {
        const thinking = thinkingParamsFor(model, 'high', maxTokens).thinking as {
          budget_tokens: number;
        };
        expect(thinking.budget_tokens).toBeLessThan(maxTokens);
        expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
      }
    });

    it('omits thinking entirely when max_tokens leaves no room for a valid budget', () => {
      // budget_tokens has a floor of 1024 and must be < max_tokens; sending an invalid
      // pair is a 400, so the field is dropped instead.
      expect(thinkingParamsFor(model, 'high', 1024)).not.toHaveProperty('thinking');
    });

    it('has a smaller context window and output cap than the Opus tier', () => {
      const haiku = capabilitiesFor(model);
      const opus = capabilitiesFor(ANTHROPIC_MODELS.opus);
      expect(haiku.contextWindow).toBeLessThan(opus.contextWindow);
      expect(haiku.maxOutputTokens).toBeLessThan(opus.maxOutputTokens);
    });
  });

  describe('unknown models', () => {
    it('degrades to a conservative shape rather than guessing', () => {
      const caps = capabilitiesFor('some-future-model');
      expect(caps.adaptiveThinking).toBe(false);
      expect(caps.effort).toBe(false);
      expect(caps.compaction).toBe(false);
      expect(isKnownModel('some-future-model')).toBe(false);
    });

    it('sends neither effort nor adaptive thinking for an unknown model', () => {
      const params = thinkingParamsFor('some-future-model', 'high', 32_000);
      expect(params).not.toHaveProperty('output_config');
      expect((params.thinking as Record<string, unknown>)?.type).not.toBe('adaptive');
    });
  });

  it('every configured model ID is known to the table', () => {
    for (const model of Object.values(ANTHROPIC_MODELS)) {
      expect(isKnownModel(model)).toBe(true);
    }
  });
});
