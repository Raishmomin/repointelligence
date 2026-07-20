import { beforeEach, describe, expect, it } from 'vitest';
import {
  __getConfig,
  __resetConfig,
  __setConfig,
  __setWorkspaceConfig,
} from '../mocks/vscode';
import { ProviderConfigStore } from '../../src/layer3-reasoning/providers/ProviderConfigStore';
import { ProviderDescriptor } from '../../src/layer3-reasoning/providers/descriptor';

const KEY = 'repo-intelligence.providers';

/** Minimal secret storage double. */
function makeSecrets() {
  const store = new Map<string, string>();
  return {
    store: async (key: string, value: string) => void store.set(key, value),
    get: async (key: string) => store.get(key),
    delete: async (key: string) => void store.delete(key),
    onDidChange: () => ({ dispose: () => {} }),
    _raw: store,
  };
}

const alpha: ProviderDescriptor = {
  id: 'alpha',
  label: 'Alpha',
  description: 'test provider',
  capabilities: { chat: true, embeddings: false, nativeTools: true, local: false },
  fallbackRank: 100,
  fields: [
    { id: 'apiKey', kind: 'secret', label: 'API Key', required: true, secretKey: 'test.alpha.apiKey' },
    { id: 'model', kind: 'string', label: 'Model', required: true, default: 'alpha-default' },
    { id: 'baseUrl', kind: 'url', label: 'Base URL', required: false, default: 'https://alpha.test' },
  ],
  create: () => ({}) as never,
};

const beta: ProviderDescriptor = {
  id: 'beta',
  label: 'Beta',
  description: 'other provider',
  capabilities: { chat: true, embeddings: true, nativeTools: false, local: true },
  fallbackRank: 10,
  fields: [
    {
      id: 'model',
      kind: 'string',
      label: 'Model',
      required: true,
      default: 'beta-default',
      legacySettingKey: 'legacy.beta.model',
    },
  ],
  create: () => ({}) as never,
};

describe('ProviderConfigStore', () => {
  let secrets: ReturnType<typeof makeSecrets>;
  let store: ProviderConfigStore;

  beforeEach(() => {
    __resetConfig();
    secrets = makeSecrets();
    store = new ProviderConfigStore(secrets as never);
  });

  describe('reading', () => {
    it('falls back to field defaults when nothing is stored', () => {
      expect(store.read(alpha)).toMatchObject({ model: 'alpha-default', baseUrl: 'https://alpha.test' });
    });

    it('prefers a stored value over the default', () => {
      __setConfig(KEY, { alpha: { model: 'alpha-custom' } });
      expect(store.read(alpha).model).toBe('alpha-custom');
    });

    it('falls back to the legacy flat key, so existing settings keep working', () => {
      __setConfig('repo-intelligence.legacy.beta.model', 'from-old-settings');
      expect(store.read(beta).model).toBe('from-old-settings');
    });

    it('prefers the new key over the legacy one once migrated', () => {
      __setConfig('repo-intelligence.legacy.beta.model', 'old');
      __setConfig(KEY, { beta: { model: 'new' } });
      expect(store.read(beta).model).toBe('new');
    });

    it('never surfaces secret fields as settings', () => {
      expect(store.read(alpha)).not.toHaveProperty('apiKey');
    });
  });

  describe('writing — the merge that must not lose data', () => {
    it('does not wipe another provider when saving one', async () => {
      // config.update on an object replaces it wholesale; a naive write loses `beta`.
      __setConfig(KEY, { beta: { model: 'beta-keep' } });

      await store.write(alpha, { model: 'alpha-new' });

      expect(__getConfig(KEY)).toEqual({
        beta: { model: 'beta-keep' },
        alpha: { model: 'alpha-new' },
      });
    });

    it('replaces its own entry rather than merging into it', async () => {
      __setConfig(KEY, { alpha: { model: 'old', baseUrl: 'https://old.test' } });
      await store.write(alpha, { model: 'new' });

      // baseUrl was not supplied this time, so it should be gone rather than lingering.
      expect(__getConfig(KEY)).toEqual({ alpha: { model: 'new' } });
    });

    it('omits empty and undefined values instead of storing blanks', async () => {
      await store.write(alpha, { model: 'x', baseUrl: '' });
      expect(__getConfig(KEY)).toEqual({ alpha: { model: 'x' } });
    });

    it('writes to workspace scope when a workspace value already exists', async () => {
      // Object settings do not deep-merge across scopes, so a global write would be
      // silently shadowed by the existing workspace value.
      __setWorkspaceConfig(KEY, { beta: { model: 'ws' } });
      await store.write(alpha, { model: 'a' });

      expect(__getConfig(KEY)).toEqual({ beta: { model: 'ws' }, alpha: { model: 'a' } });
    });

    it('writes to global scope when there is no workspace value', async () => {
      await store.write(alpha, { model: 'a' });
      expect(__getConfig(KEY)).toEqual({ alpha: { model: 'a' } });
    });

    it('refuses to write a secret into settings', async () => {
      // The one mistake here that would genuinely hurt: a key in settings.json, which
      // syncs across machines and gets committed.
      await expect(store.write(alpha, { model: 'x', apiKey: 'sk-leaked' })).rejects.toThrow(
        /Refusing to write secret/,
      );
      expect(__getConfig(KEY)).toBeUndefined();
    });
  });

  describe('secrets', () => {
    it('round-trips through SecretStorage under the declared key', async () => {
      const field = alpha.fields[0] as never as { secretKey: string };
      await store.writeSecret(alpha.fields[0] as never, 'sk-test');
      expect(secrets._raw.get(field.secretKey)).toBe('sk-test');
    });

    it('clears every secret a provider declares', async () => {
      await store.writeSecret(alpha.fields[0] as never, 'sk-test');
      await store.clearSecrets(alpha);
      expect(secrets._raw.size).toBe(0);
    });
  });

  describe('isConfigured — the no-I/O fallback prefilter', () => {
    it('is false when a required secret is missing', async () => {
      __setConfig(KEY, { alpha: { model: 'x' } });
      expect(await store.isConfigured(alpha)).toBe(false);
    });

    it('is true once every required field has a value', async () => {
      __setConfig(KEY, { alpha: { model: 'x' } });
      await store.writeSecret(alpha.fields[0] as never, 'sk-test');
      expect(await store.isConfigured(alpha)).toBe(true);
    });

    it('ignores optional fields', async () => {
      await store.writeSecret(alpha.fields[0] as never, 'sk-test');
      // model has a default, baseUrl is optional
      expect(await store.isConfigured(alpha)).toBe(true);
    });

    it('is satisfied by defaults alone for a provider with no secrets', async () => {
      expect(await store.isConfigured(beta)).toBe(true);
    });
  });

  describe('draft context', () => {
    it('layers unsaved values over persisted ones', () => {
      __setConfig(KEY, { alpha: { baseUrl: 'https://saved.test' } });
      const context = store.draftContext(alpha, { baseUrl: 'https://typed-just-now.test' });

      // A dynamic model list must see the URL the user just typed, not the saved one —
      // otherwise it lists models for the previous host and the bug is invisible.
      expect(context.getString('baseUrl')).toBe('https://typed-just-now.test');
    });

    it('falls through to persisted values for untouched fields', () => {
      __setConfig(KEY, { alpha: { model: 'saved-model' } });
      const context = store.draftContext(alpha, { baseUrl: 'https://new.test' });
      expect(context.getString('model')).toBe('saved-model');
    });

    it('exposes a secret typed into the wizard but not yet stored', async () => {
      const context = store.draftContext(alpha, { apiKey: 'sk-just-typed' });
      expect(await context.getSecret('apiKey')).toBe('sk-just-typed');
    });

    it('falls back to stored secrets when the draft has none', async () => {
      await store.writeSecret(alpha.fields[0] as never, 'sk-stored');
      const context = store.draftContext(alpha, {});
      expect(await context.getSecret('apiKey')).toBe('sk-stored');
    });

    it('returns undefined for a non-secret field asked for as a secret', async () => {
      const context = store.draftContext(alpha, {});
      expect(await context.getSecret('model')).toBeUndefined();
    });
  });

  describe('typed reads', () => {
    it('coerces numbers and falls back when unparseable', () => {
      __setConfig(KEY, { alpha: { model: 'not-a-number' } });
      const context = store.context(alpha);
      expect(context.getNumber('model', 42)).toBe(42);
    });

    it('treats an empty string as absent', () => {
      __setConfig(KEY, { alpha: { baseUrl: '' } });
      expect(store.context(alpha).getString('baseUrl', 'fallback')).toBe('fallback');
    });
  });
});
