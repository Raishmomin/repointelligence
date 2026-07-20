import {
  chatModelField,
  FieldValues,
  isSecretField,
  ProviderDescriptor,
  ProviderOption,
  SecretFieldSchema,
} from './descriptor';
import { ProviderConfigStore } from './ProviderConfigStore';
import { ProviderFactory } from './ProviderFactory';
import { ProviderRegistry } from './ProviderRegistry';
import { ProviderId } from './types';

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

/**
 * The three host-side operations provider setup needs: list a provider's models, validate a
 * draft configuration, and persist it.
 *
 * Both the QuickPick wizard and the future React panel call exactly this, so the two
 * frontends cannot drift apart in what "saving a provider" means.
 */
export class ProviderSetupService {
  constructor(
    private readonly factory: ProviderFactory,
    private readonly registry: ProviderRegistry = factory.getRegistry(),
    private readonly store: ProviderConfigStore = factory.getStore(),
  ) {}

  /**
   * Models available for a provider, given a possibly-unsaved draft.
   *
   * The draft matters: a dynamic list needs the base URL or key the user typed moments ago.
   * Reading persisted config here would list models for the *previous* host, and the bug
   * only shows up when someone changes hosts.
   */
  async listModels(
    id: ProviderId,
    fieldId: string,
    draft: FieldValues,
  ): Promise<{ options: ProviderOption[]; allowCustom: boolean; error?: string }> {
    const descriptor = this.registry.require(id);
    const field = descriptor.fields.find((candidate) => candidate.id === fieldId);

    if (!field || field.kind !== 'model') {
      return { options: [], allowCustom: true, error: `"${fieldId}" is not a model field.` };
    }

    if (field.source.type === 'fixed') {
      return { options: field.source.options, allowCustom: false };
    }

    try {
      const options = await field.source.list(this.store.draftContext(descriptor, draft));
      return options.length
        ? { options, allowCustom: field.source.allowCustom }
        : { options: [], allowCustom: field.source.allowCustom, error: field.source.emptyMessage };
    } catch (error) {
      return {
        options: [],
        allowCustom: field.source.allowCustom,
        error: `${field.source.emptyMessage}\n(${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }

  /**
   * Builds a throwaway provider from the draft and asks whether it can actually run.
   *
   * Constructed from the draft rather than persisted config so validation tests what the
   * user is about to save, not what is already saved.
   */
  async validate(id: ProviderId, draft: FieldValues): Promise<ValidationResult> {
    const descriptor = this.registry.require(id);
    try {
      const probe = descriptor.create({
        secrets: this.factory.getSecrets(),
        config: this.store.draftContext(descriptor, draft),
        logger: this.factory.getLogger(),
        services: this.factory.getServices(),
      });
      if (await probe.isAvailable()) return { ok: true };
      return { ok: false, message: (await probe.unavailableReason()) ?? `${descriptor.label} is unavailable.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Persists a draft and makes the provider active.
   *
   * Ordering is deliberate — secrets, then settings, then the active provider *last*. An
   * abort or failure part-way through can therefore never leave the extension pointed at a
   * half-configured backend.
   */
  async save(id: ProviderId, draft: FieldValues): Promise<void> {
    const descriptor = this.registry.require(id);

    const settings: FieldValues = {};
    for (const field of descriptor.fields) {
      const value = draft[field.id];
      if (value === undefined) continue;

      if (isSecretField(field)) {
        // An empty secret means "keep what is stored", not "clear it" — otherwise pressing
        // Enter past the masked prompt would silently wipe a working key.
        if (typeof value === 'string' && value) await this.store.writeSecret(field, value);
      } else {
        settings[field.id] = value;
      }
    }

    await this.store.write(descriptor, settings);
    await ProviderConfigStore.setActiveProvider(id);
    this.factory.invalidate(id);
  }

  /**
   * Switches a provider's chat model, preserving its other settings.
   *
   * Deliberately not expressed as `save(id, { model })`. `ProviderConfigStore.write()`
   * rebuilds a provider's settings entry from only the values it is handed, so a partial
   * draft silently deletes every field it omits — a model switch would wipe the base URL,
   * context window and embedding model. The read-merge lives here, once, rather than being
   * repeated (and eventually forgotten) at each call site.
   */
  async setChatModel(id: ProviderId, model: string): Promise<void> {
    const descriptor = this.registry.require(id);
    const field = chatModelField(descriptor);
    if (!field) throw new Error(`${descriptor.label} has no chat model field.`);

    await this.save(id, { ...this.store.read(descriptor), [field.id]: model });
  }

  /** Which providers are ready to run, for annotating the picker without probing anything. */
  async configuredState(): Promise<Map<ProviderId, boolean>> {
    const state = new Map<ProviderId, boolean>();
    for (const descriptor of this.registry.chatCapable()) {
      state.set(descriptor.id, await this.store.isConfigured(descriptor));
    }
    return state;
  }

  secretFieldsOf(descriptor: ProviderDescriptor): SecretFieldSchema[] {
    return descriptor.fields.filter(isSecretField);
  }

  async hasStoredSecret(field: SecretFieldSchema): Promise<boolean> {
    return this.store.hasSecret(field);
  }
}
