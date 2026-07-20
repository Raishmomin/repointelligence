import { describe, expect, it } from 'vitest';
import {
  assessModel,
  parseParameterBillions,
  rankModels,
} from '../../src/layer3-reasoning/providers/ollamaModels';

describe('parseParameterBillions', () => {
  it('reads the size from a standard Ollama tag', () => {
    expect(parseParameterBillions('qwen2.5-coder:7b')).toBe(7);
    expect(parseParameterBillions('llama3.1:70b')).toBe(70);
    expect(parseParameterBillions('gemma2:2b')).toBe(2);
  });

  it('reads fractional sizes', () => {
    expect(parseParameterBillions('phi3:3.8b')).toBe(3.8);
  });

  it('does not mistake a version number for a size', () => {
    // "qwen2.5-coder" must not parse as 2.5 billion parameters.
    expect(parseParameterBillions('qwen2.5-coder:32b')).toBe(32);
    expect(parseParameterBillions('llama3.1:8b')).toBe(8);
  });

  it('returns undefined when the tag carries no size', () => {
    expect(parseParameterBillions('qwen2.5-coder:latest')).toBeUndefined();
    expect(parseParameterBillions('mistral')).toBeUndefined();
  });
});

describe('assessModel', () => {
  describe('models that can drive the agent', () => {
    it('accepts a 7B coder model', () => {
      expect(assessModel('qwen2.5-coder:7b').fitness).toBe('good');
    });

    it('accepts larger coder models', () => {
      expect(assessModel('deepseek-coder-v2:16b').fitness).toBe('good');
      expect(assessModel('qwen2.5-coder:32b').fitness).toBe('good');
    });

    it('accepts capable general models at sufficient size', () => {
      expect(assessModel('llama3.1:70b').fitness).toBe('good');
      expect(assessModel('mixtral:8x7b').fitness).toBe('good');
    });

    it('returns no warning for a good model', () => {
      expect(assessModel('qwen2.5-coder:7b').warning).toBeUndefined();
    });
  });

  describe('models that cannot', () => {
    it('rejects the old default, gemma2:2b', () => {
      // This shipped as the default and is the likely cause of the reported
      // "please give me the path" behaviour.
      const assessment = assessModel('gemma2:2b');
      expect(assessment.fitness).toBe('poor');
      expect(assessment.parameterBillions).toBe(2);
    });

    it('explains the symptom, not just the size', () => {
      const { warning } = assessModel('gemma2:2b');
      expect(warning).toMatch(/asking you where files are/i);
      expect(warning).toContain('qwen2.5-coder:7b');
    });

    it('rejects any sub-3B model regardless of family', () => {
      expect(assessModel('qwen2.5-coder:1.5b').fitness).toBe('poor');
      expect(assessModel('llama3.2:1b').fitness).toBe('poor');
    });

    it('treats 3B-7B as marginal rather than unusable', () => {
      expect(assessModel('llama3.2:3b').fitness).toBe('marginal');
      expect(assessModel('phi3:3.8b').fitness).toBe('marginal');
    });
  });

  describe('unknown models', () => {
    it('is cautious without crying wolf', () => {
      const assessment = assessModel('some-new-model:latest');
      expect(assessment.fitness).toBe('marginal');
      expect(assessment.warning).toBeDefined();
    });

    it('falls back to a parameter hint when the tag has no size', () => {
      expect(assessModel('mystery:latest', '1.5B').fitness).toBe('poor');
    });
  });
});

describe('rankModels', () => {
  it('puts usable models before unusable ones', () => {
    const ranked = rankModels([
      { name: 'gemma2:2b' },
      { name: 'qwen2.5-coder:7b' },
      { name: 'llama3.2:3b' },
    ]);
    expect(ranked.map((model) => model.name)).toEqual([
      'qwen2.5-coder:7b',
      'llama3.2:3b',
      'gemma2:2b',
    ]);
  });

  it('prefers the larger model within the same fitness band', () => {
    const ranked = rankModels([{ name: 'qwen2.5-coder:7b' }, { name: 'qwen2.5-coder:32b' }]);
    expect(ranked[0].name).toBe('qwen2.5-coder:32b');
  });

  it('is deterministic for otherwise equal models', () => {
    const models = [{ name: 'b-model:7b' }, { name: 'a-model:7b' }];
    expect(rankModels(models).map((m) => m.name)).toEqual(rankModels(models).map((m) => m.name));
  });

  it('does not mutate the input array', () => {
    const models = [{ name: 'gemma2:2b' }, { name: 'qwen2.5-coder:7b' }];
    rankModels(models);
    expect(models[0].name).toBe('gemma2:2b');
  });
});
