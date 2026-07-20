import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetConfig, __setConfig } from '../mocks/vscode';
import { ProviderFactory } from '../../src/layer3-reasoning/providers/ProviderFactory';
import { ProviderRegistry } from '../../src/layer3-reasoning/providers/ProviderRegistry';
import { ProviderConfigStore } from '../../src/layer3-reasoning/providers/ProviderConfigStore';
import { ProviderDescriptor } from '../../src/layer3-reasoning/providers/descriptor';
import { LlmProvider } from '../../src/layer3-reasoning/providers/types';

function makeSecrets() {
  const store = new Map<string, string>();
  return {
    store: async (k: string, v: string) => void store.set(k, v),
    get: async (k: string) => store.get(k),
    delete: async (k: string) => void store.delete(k),
    onDidChange: () => ({ dispose: () => {} }),
  };
}

/** Counts probes so we can assert unconfigured providers are skipped without network I/O. */
function fakeProvider(id: string, available: boolean, reason = `${id} unavailable`) {
  const probes = { count: 0 };
  const provider: LlmProvider = {
    id,
    supportsNativeTools: true,
    contextWindow: 1000,
    modelId: `${id}-model`,
    isAvailable: async () => {
      probes.count++;
      return available;
    },
    unavailableReason: async () => (available ? undefined : reason),
    streamTurn: async () => ({ content: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }),
  };
  return { provider, probes };
}

function descriptorFor(
  id: string,
  provider: LlmProvider,
  options: { rank?: number; requiresKey?: boolean } = {},
): ProviderDescriptor {
  return {
    id,
    label: id.toUpperCase(),
    description: id,
    capabilities: { chat: true, embeddings: false, nativeTools: true, local: false },
    fallbackRank: options.rank ?? 50,
    fields: options.requiresKey
      ? [{ id: 'apiKey', kind: 'secret', label: 'Key', required: true, secretKey: `test.${id}.key` }]
      : [],
    create: () => provider,
  };
}

describe('ProviderFactory', () => {
  let secrets: ReturnType<typeof makeSecrets>;

  beforeEach(() => {
    __resetConfig();
    secrets = makeSecrets();
    vi.restoreAllMocks();
  });

  function build(descriptors: ProviderDescriptor[]) {
    const registry = new ProviderRegistry(descriptors);
    const store = new ProviderConfigStore(secrets as never);
    // OllamaClient is only touched on config-change events, so a stub suffices here.
    const ollama = { updateConfig: () => {} } as never;
    return new ProviderFactory(secrets as never, ollama, registry, store);
  }

  describe('happy path', () => {
    it('uses the configured provider when it is available', async () => {
      const primary = fakeProvider('primary', true);
      __setConfig('repo-intelligence.provider', 'primary');

      const resolution = await build([descriptorFor('primary', primary.provider)]).resolveChatProvider();

      expect(resolution?.providerId).toBe('primary');
      expect(resolution?.reason).toBe('configured');
      expect(resolution?.notice).toBeUndefined();
    });

    it('reports the model that will actually run', async () => {
      const primary = fakeProvider('primary', true);
      __setConfig('repo-intelligence.provider', 'primary');

      const resolution = await build([descriptorFor('primary', primary.provider)]).resolveChatProvider();
      expect(resolution?.model).toBe('primary-model');
    });
  });

  describe('fallback', () => {
    it('falls through to the next available provider', async () => {
      const broken = fakeProvider('broken', false, 'no key configured');
      const backup = fakeProvider('backup', true);
      __setConfig('repo-intelligence.provider', 'broken');

      const resolution = await build([
        descriptorFor('broken', broken.provider, { rank: 100 }),
        descriptorFor('backup', backup.provider, { rank: 10 }),
      ]).resolveChatProvider();

      expect(resolution?.providerId).toBe('backup');
      expect(resolution?.reason).toBe('fallback');
      expect(resolution?.fallbackFrom).toBe('broken');
    });

    it('explains what failed, so a silent downgrade is visible', async () => {
      const broken = fakeProvider('broken', false, 'Ollama is not reachable.');
      const backup = fakeProvider('backup', true);
      __setConfig('repo-intelligence.provider', 'broken');

      const resolution = await build([
        descriptorFor('broken', broken.provider),
        descriptorFor('backup', backup.provider),
      ]).resolveChatProvider();

      expect(resolution?.notice).toContain('Ollama is not reachable.');
      expect(resolution?.notice).toContain('BACKUP');
    });

    it('records every provider it tried and why each failed', async () => {
      const first = fakeProvider('first', false, 'first down');
      const second = fakeProvider('second', false, 'second down');
      const third = fakeProvider('third', true);
      __setConfig('repo-intelligence.provider', 'first');

      const resolution = await build([
        descriptorFor('first', first.provider, { rank: 100 }),
        descriptorFor('second', second.provider, { rank: 50 }),
        descriptorFor('third', third.provider, { rank: 10 }),
      ]).resolveChatProvider();

      expect(resolution?.attempted).toEqual([
        { id: 'first', reason: 'first down' },
        { id: 'second', reason: 'second down' },
      ]);
    });

    it('follows rank order', async () => {
      const broken = fakeProvider('broken', false);
      const low = fakeProvider('low', true);
      const high = fakeProvider('high', true);
      __setConfig('repo-intelligence.provider', 'broken');

      const resolution = await build([
        descriptorFor('broken', broken.provider, { rank: 100 }),
        descriptorFor('low', low.provider, { rank: 1 }),
        descriptorFor('high', high.provider, { rank: 90 }),
      ]).resolveChatProvider();

      expect(resolution?.providerId).toBe('high');
    });

    it('honours an explicitly pinned fallback order over rank', async () => {
      const broken = fakeProvider('broken', false);
      const low = fakeProvider('low', true);
      const high = fakeProvider('high', true);
      __setConfig('repo-intelligence.provider', 'broken');
      __setConfig('repo-intelligence.providerFallbackOrder', ['low', 'high']);

      const resolution = await build([
        descriptorFor('broken', broken.provider, { rank: 100 }),
        descriptorFor('low', low.provider, { rank: 1 }),
        descriptorFor('high', high.provider, { rank: 90 }),
      ]).resolveChatProvider();

      expect(resolution?.providerId).toBe('low');
    });

    it('skips unconfigured providers without probing them', async () => {
      // The prefilter is what stops N providers costing N network round trips per run.
      const broken = fakeProvider('broken', false);
      const needsKey = fakeProvider('needsKey', true);
      __setConfig('repo-intelligence.provider', 'broken');

      const resolution = await build([
        descriptorFor('broken', broken.provider, { rank: 100 }),
        descriptorFor('needsKey', needsKey.provider, { rank: 50, requiresKey: true }),
      ]).resolveChatProvider();

      expect(resolution).toBeUndefined();
      expect(needsKey.probes.count).toBe(0);
    });

    it('probes a provider once its required secret exists', async () => {
      const broken = fakeProvider('broken', false);
      const needsKey = fakeProvider('needsKey', true);
      await secrets.store('test.needsKey.key', 'sk-present');
      __setConfig('repo-intelligence.provider', 'broken');

      const resolution = await build([
        descriptorFor('broken', broken.provider, { rank: 100 }),
        descriptorFor('needsKey', needsKey.provider, { rank: 50, requiresKey: true }),
      ]).resolveChatProvider();

      expect(resolution?.providerId).toBe('needsKey');
    });

    it('does not fall back at all when fallback is off', async () => {
      const broken = fakeProvider('broken', false);
      const backup = fakeProvider('backup', true);
      __setConfig('repo-intelligence.provider', 'broken');
      __setConfig('repo-intelligence.providerFallback', 'off');

      const resolution = await build([
        descriptorFor('broken', broken.provider),
        descriptorFor('backup', backup.provider),
      ]).resolveChatProvider();

      expect(resolution).toBeUndefined();
      expect(backup.probes.count).toBe(0);
    });

    it('returns undefined when nothing is available', async () => {
      const a = fakeProvider('a', false);
      const b = fakeProvider('b', false);
      __setConfig('repo-intelligence.provider', 'a');

      expect(
        await build([descriptorFor('a', a.provider), descriptorFor('b', b.provider)]).resolveChatProvider(),
      ).toBeUndefined();
    });
  });

  describe('unknown configured provider', () => {
    it('falls back to the top-ranked provider instead of crashing', async () => {
      // A typo in settings, or a provider removed by a downgrade, must not break the agent.
      const top = fakeProvider('top', true);
      __setConfig('repo-intelligence.provider', 'does-not-exist');

      const factory = build([descriptorFor('top', top.provider, { rank: 100 })]);
      expect(factory.configuredProviderId).toBe('top');
      expect((await factory.resolveChatProvider())?.providerId).toBe('top');
    });
  });

  describe('instance caching', () => {
    it('constructs each provider once', () => {
      const primary = fakeProvider('primary', true);
      const create = vi.fn(() => primary.provider);
      const factory = build([{ ...descriptorFor('primary', primary.provider), create }]);

      factory.instance('primary');
      factory.instance('primary');
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('rebuilds after invalidation when the provider has no invalidate() of its own', () => {
      const primary = fakeProvider('primary', true);
      const create = vi.fn(() => primary.provider);
      const factory = build([{ ...descriptorFor('primary', primary.provider), create }]);

      factory.instance('primary');
      factory.invalidate('primary');
      factory.instance('primary');
      expect(create).toHaveBeenCalledTimes(2);
    });
  });

  describe('availability caching', () => {
    it('does not re-probe within the TTL', async () => {
      const primary = fakeProvider('primary', true);
      __setConfig('repo-intelligence.provider', 'primary');
      const factory = build([descriptorFor('primary', primary.provider)]);

      await factory.resolveChatProvider();
      await factory.resolveChatProvider();
      expect(primary.probes.count).toBe(1);
    });

    it('re-probes after invalidation', async () => {
      const primary = fakeProvider('primary', true);
      __setConfig('repo-intelligence.provider', 'primary');
      const factory = build([descriptorFor('primary', primary.provider)]);

      await factory.resolveChatProvider();
      factory.invalidate('primary');
      await factory.resolveChatProvider();
      expect(primary.probes.count).toBe(2);
    });
  });
});
