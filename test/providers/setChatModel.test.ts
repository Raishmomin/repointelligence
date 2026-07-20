import { beforeEach, describe, expect, it } from 'vitest';
import { __getConfig, __resetConfig, __setConfig } from '../mocks/vscode';
import { ProviderConfigStore } from '../../src/layer3-reasoning/providers/ProviderConfigStore';
import { ProviderRegistry } from '../../src/layer3-reasoning/providers/ProviderRegistry';
import { ProviderSetupService } from '../../src/layer3-reasoning/providers/ProviderSetupService';
import { ProviderDescriptor } from '../../src/layer3-reasoning/providers/descriptor';

const KEY = 'repo-intelligence.providers';

function makeSecrets() {
  const store = new Map<string, string>();
  return {
    store: async (k: string, v: string) => void store.set(k, v),
    get: async (k: string) => store.get(k),
    delete: async (k: string) => void store.delete(k),
    onDidChange: () => ({ dispose: () => {} }),
  };
}

/** Mirrors the real Ollama descriptor's shape: a model field plus several siblings. */
const multiField: ProviderDescriptor = {
  id: 'local',
  label: 'Local',
  description: 'test',
  capabilities: { chat: true, embeddings: false, nativeTools: false, local: true },
  fallbackRank: 10,
  fields: [
    { id: 'baseUrl', kind: 'url', label: 'URL', required: true, default: 'http://127.0.0.1:11434' },
    {
      id: 'model',
      kind: 'model',
      label: 'Model',
      required: true,
      role: 'chat',
      source: { type: 'fixed', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] },
    },
    { id: 'embeddingModel', kind: 'string', label: 'Embedding model', required: false },
    { id: 'contextWindow', kind: 'number', label: 'Context', required: false, default: 32000 },
  ],
  create: () => ({}) as never,
};

const noModelField: ProviderDescriptor = {
  id: 'weird',
  label: 'Weird',
  description: 'test',
  capabilities: { chat: true, embeddings: false, nativeTools: true, local: false },
  fallbackRank: 1,
  fields: [{ id: 'baseUrl', kind: 'url', label: 'URL', required: true }],
  create: () => ({}) as never,
};

describe('ProviderSetupService.setChatModel', () => {
  let setup: ProviderSetupService;
  let store: ProviderConfigStore;

  beforeEach(() => {
    __resetConfig();
    const secrets = makeSecrets();
    store = new ProviderConfigStore(secrets as never);
    const registry = new ProviderRegistry([multiField, noModelField]);
    const factory = {
      getRegistry: () => registry,
      getStore: () => store,
      invalidate: () => {},
    };
    setup = new ProviderSetupService(factory as never, registry, store);
  });

  it('preserves every other setting when switching model', async () => {
    // The regression this method exists for. ProviderConfigStore.write() rebuilds a
    // provider's entry from only the values handed to it, so save(id, {model}) would
    // silently delete baseUrl, embeddingModel and contextWindow.
    __setConfig(KEY, {
      local: {
        baseUrl: 'http://my-server:11434',
        model: 'a',
        embeddingModel: 'nomic-embed-text',
        contextWindow: 64000,
      },
    });

    await setup.setChatModel('local', 'b');

    expect((__getConfig(KEY) as Record<string, unknown>).local).toEqual({
      baseUrl: 'http://my-server:11434',
      model: 'b',
      embeddingModel: 'nomic-embed-text',
      contextWindow: 64000,
    });
  });

  it('actually changes the model', async () => {
    __setConfig(KEY, { local: { baseUrl: 'http://x', model: 'a' } });
    await setup.setChatModel('local', 'b');

    const saved = (__getConfig(KEY) as Record<string, Record<string, unknown>>).local;
    expect(saved.model).toBe('b');
  });

  it('does not disturb other providers', async () => {
    __setConfig(KEY, {
      local: { baseUrl: 'http://x', model: 'a' },
      other: { apiThing: 'keep-me' },
    });

    await setup.setChatModel('local', 'b');

    expect((__getConfig(KEY) as Record<string, unknown>).other).toEqual({ apiThing: 'keep-me' });
  });

  it('materialises defaults for fields never explicitly set', async () => {
    // read() falls back to defaults, so the merged write pins them. Acceptable: the
    // alternative is losing them, and the values are what was already in effect.
    __setConfig(KEY, { local: { model: 'a' } });
    await setup.setChatModel('local', 'b');

    const saved = (__getConfig(KEY) as Record<string, Record<string, unknown>>).local;
    expect(saved.baseUrl).toBe('http://127.0.0.1:11434');
    expect(saved.contextWindow).toBe(32000);
  });

  it('makes the provider active, so switching model across providers switches provider', async () => {
    __setConfig('repo-intelligence.provider', 'other');
    __setConfig(KEY, { local: { model: 'a' } });

    await setup.setChatModel('local', 'b');
    expect(__getConfig('repo-intelligence.provider')).toBe('local');
  });

  it('fails clearly for a provider with no chat model field', async () => {
    await expect(setup.setChatModel('weird', 'anything')).rejects.toThrow(/no chat model field/);
  });

  it('fails clearly for an unregistered provider', async () => {
    await expect(setup.setChatModel('nope', 'x')).rejects.toThrow(/Unknown model provider/);
  });
});
