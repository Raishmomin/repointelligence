import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/layer3-reasoning/providers/ProviderRegistry';
import { ProviderDescriptor } from '../../src/layer3-reasoning/providers/descriptor';
import { PROVIDER_DESCRIPTORS } from '../../src/layer3-reasoning/providers/registry';

function descriptor(overrides: Partial<ProviderDescriptor> & { id: string }): ProviderDescriptor {
  return {
    label: overrides.id,
    description: 'test',
    capabilities: { chat: true, embeddings: false, nativeTools: true, local: false },
    fallbackRank: 50,
    fields: [],
    create: () => ({}) as never,
    ...overrides,
  };
}

describe('ProviderRegistry', () => {
  describe('lookup', () => {
    it('resolves a registered provider', () => {
      const registry = new ProviderRegistry([descriptor({ id: 'a' })]);
      expect(registry.get('a')?.id).toBe('a');
    });

    it('returns undefined for an unknown id', () => {
      expect(new ProviderRegistry([descriptor({ id: 'a' })]).get('nope')).toBeUndefined();
    });

    it('require() names the valid ids, since the union no longer catches typos', () => {
      const registry = new ProviderRegistry([descriptor({ id: 'a' }), descriptor({ id: 'b' })]);
      expect(() => registry.require('typo')).toThrow(/Unknown model provider "typo"/);
      expect(() => registry.require('typo')).toThrow(/a, b/);
    });

    it('rejects duplicate ids at construction rather than silently shadowing', () => {
      expect(() => new ProviderRegistry([descriptor({ id: 'dup' }), descriptor({ id: 'dup' })])).toThrow(
        /Duplicate provider id "dup"/,
      );
    });
  });

  describe('capability filters', () => {
    it('lists only chat-capable providers', () => {
      const registry = new ProviderRegistry([
        descriptor({ id: 'chat' }),
        descriptor({
          id: 'embedonly',
          capabilities: { chat: false, embeddings: true, nativeTools: false, local: true },
        }),
      ]);
      expect(registry.chatCapable().map((d) => d.id)).toEqual(['chat']);
    });

    it('excludes an embeddings-capable provider that cannot actually build an embedder', () => {
      const registry = new ProviderRegistry([
        descriptor({
          id: 'claims-but-cannot',
          capabilities: { chat: true, embeddings: true, nativeTools: true, local: false },
          // no createEmbedder
        }),
      ]);
      expect(registry.embedCapable()).toEqual([]);
    });

    it('includes one that can', () => {
      const registry = new ProviderRegistry([
        descriptor({
          id: 'real',
          capabilities: { chat: true, embeddings: true, nativeTools: true, local: false },
          createEmbedder: () => ({}) as never,
        }),
      ]);
      expect(registry.embedCapable().map((d) => d.id)).toEqual(['real']);
    });
  });

  describe('fallback ordering', () => {
    it('sorts by descending rank', () => {
      const registry = new ProviderRegistry([
        descriptor({ id: 'low', fallbackRank: 1 }),
        descriptor({ id: 'high', fallbackRank: 100 }),
        descriptor({ id: 'mid', fallbackRank: 50 }),
      ]);
      expect(registry.byFallbackRank().map((d) => d.id)).toEqual(['high', 'mid', 'low']);
    });

    it('breaks ties by id so the order is stable across runs', () => {
      const registry = new ProviderRegistry([
        descriptor({ id: 'z', fallbackRank: 10 }),
        descriptor({ id: 'a', fallbackRank: 10 }),
      ]);
      expect(registry.byFallbackRank().map((d) => d.id)).toEqual(['a', 'z']);
    });
  });

  describe('visibleWhen', () => {
    const conditional = new ProviderRegistry([
      descriptor({
        id: 'p',
        fields: [
          { id: 'mode', kind: 'string', label: 'Mode', required: true },
          {
            id: 'endpoint',
            kind: 'url',
            label: 'Endpoint',
            required: false,
            visibleWhen: { field: 'mode', equals: ['custom'] },
          },
          {
            id: 'note',
            kind: 'string',
            label: 'Note',
            required: false,
            visibleWhen: { field: 'mode', isSet: true },
          },
        ],
      }),
    ]);

    it('hides a field whose condition is unmet', () => {
      expect(conditional.fieldsFor('p', { mode: 'default' }).map((f) => f.id)).toEqual(['mode', 'note']);
    });

    it('shows it once the condition is met', () => {
      expect(conditional.fieldsFor('p', { mode: 'custom' }).map((f) => f.id)).toEqual([
        'mode',
        'endpoint',
        'note',
      ]);
    });

    it('treats an unset field as not set', () => {
      expect(conditional.fieldsFor('p', {}).map((f) => f.id)).toEqual(['mode']);
    });

    it('treats an empty string as not set', () => {
      expect(conditional.fieldsFor('p', { mode: '' }).map((f) => f.id)).toEqual(['mode']);
    });
  });

  describe('adding a provider costs one registry entry', () => {
    it('picks up a new provider with no other change', () => {
      // The whole point of the registry: this is what adding a vendor looks like.
      const withNew = new ProviderRegistry([
        ...PROVIDER_DESCRIPTORS,
        descriptor({ id: 'mistral', fallbackRank: 65 }),
      ]);

      expect(withNew.get('mistral')).toBeDefined();
      expect(withNew.chatCapable().map((d) => d.id)).toContain('mistral');

      // And it slots into the fallback chain purely by rank, with no code change.
      const ranked = withNew.byFallbackRank().map((d) => d.id);
      expect(ranked.indexOf('mistral')).toBeGreaterThan(ranked.indexOf('anthropic'));
      expect(ranked.indexOf('mistral')).toBeLessThan(ranked.indexOf('ollama'));
    });
  });

  describe('the real registry', () => {
    it('registers every shipped provider with unique ids', () => {
      const registry = new ProviderRegistry();
      expect(registry.ids().sort()).toEqual([
        'anthropic',
        'gemini',
        'groq',
        'nvidia',
        'ollama',
        'openai',
        'openrouter',
      ]);
    });

    it('ranks the local provider last, so a cloud run is never quietly downgraded first', () => {
      expect(new ProviderRegistry().byFallbackRank().at(-1)?.id).toBe('ollama');
    });

    it('offers only ollama for embeddings', () => {
      // Anthropic has no embeddings endpoint, and the OpenAI-compatible vendors are held
      // back deliberately: the index has no per-row model identity, so a second embedder
      // would write incompatible-dimension vectors into it with no error.
      expect(new ProviderRegistry().embedCapable().map((d) => d.id)).toEqual(['ollama']);
    });

    it('declares a chat model field for every chat provider', () => {
      for (const provider of new ProviderRegistry().chatCapable()) {
        const hasChatModel = provider.fields.some(
          (field) => field.kind === 'model' && field.role !== 'embedding',
        );
        expect(hasChatModel, `${provider.id} needs a chat model field`).toBe(true);
      }
    });
  });
});
