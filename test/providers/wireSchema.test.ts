import { describe, expect, it } from 'vitest';
import { toWireSchema } from '../../src/layer3-reasoning/providers/descriptor';
import { ProviderRegistry } from '../../src/layer3-reasoning/providers/ProviderRegistry';

/**
 * The wire schema is what the settings panel renders from. It has to survive a
 * `postMessage` round trip, which means no functions and no secret values.
 */
describe('toWireSchema', () => {
  const registry = new ProviderRegistry();

  it('is JSON round-trippable for every registered provider', () => {
    for (const descriptor of registry.all()) {
      const wire = toWireSchema(descriptor);
      // If a function slot survived, this drops it and the comparison fails.
      expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    }
  });

  it('strips create and createEmbedder', () => {
    for (const descriptor of registry.all()) {
      const wire = toWireSchema(descriptor) as unknown as Record<string, unknown>;
      expect(wire.create).toBeUndefined();
      expect(wire.createEmbedder).toBeUndefined();
    }
  });

  it('flattens a dynamic model source to metadata the panel can act on', () => {
    const ollama = toWireSchema(registry.require('ollama'));
    const model = ollama.fields.find((field) => field.id === 'model');

    expect(model?.kind).toBe('model');
    const source = (model as { source: Record<string, unknown> }).source;
    expect(source.type).toBe('dynamic');
    // The function is gone; the panel asks the host to run it.
    expect(source.list).toBeUndefined();
    expect(source.allowCustom).toBe(true);
    expect(typeof source.emptyMessage).toBe('string');
  });

  it('keeps the options of a fixed model source inline', () => {
    const anthropic = toWireSchema(registry.require('anthropic'));
    const model = anthropic.fields.find((field) => field.id === 'model');
    const source = (model as { source: { type: string; options: unknown[] } }).source;

    expect(source.type).toBe('fixed');
    expect(source.options.length).toBeGreaterThan(0);
  });

  it('carries no secret values, only the storage key and whether one is required', () => {
    // The panel must never receive a stored key; it gets hasStoredSecret separately.
    for (const descriptor of registry.all()) {
      const wire = toWireSchema(descriptor);
      const serialised = JSON.stringify(wire);
      expect(serialised).not.toMatch(/sk-ant-[A-Za-z0-9]/);
      expect(serialised).not.toMatch(/"value"\s*:\s*"sk-/);
    }
  });

  it('preserves the field order the wizard and the form both follow', () => {
    for (const descriptor of registry.all()) {
      expect(toWireSchema(descriptor).fields.map((f) => f.id)).toEqual(
        descriptor.fields.map((f) => f.id),
      );
    }
  });

  it('gives every provider what the picker needs to render it', () => {
    for (const descriptor of registry.all()) {
      const wire = toWireSchema(descriptor);
      expect(wire.label).toBeTruthy();
      expect(wire.description).toBeTruthy();
      expect(wire.icon).toBeTruthy();
      expect(wire.capabilities).toBeDefined();
    }
  });

  it('marks which providers need an API key, so the panel can prompt for one', () => {
    const needsKey = registry
      .all()
      .filter((descriptor) => descriptor.fields.some((field) => field.kind === 'secret'))
      .map((descriptor) => descriptor.id)
      .sort();

    // Ollama is local and needs none; every cloud provider does.
    expect(needsKey).toEqual(['anthropic', 'gemini', 'groq', 'nvidia', 'openai', 'opencode-zen', 'openrouter']);
  });
});
