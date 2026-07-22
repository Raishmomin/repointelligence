import { ModelOptionDto } from '../../shared/types/webview.types';
import { chatModelField, isModelField } from './descriptor';
import { ProviderFactory } from './ProviderFactory';
import { ProviderSetupService } from './ProviderSetupService';

/**
 * Aggregates every model the user can pick, across every configured provider.
 *
 * Unconfigured providers are hidden. They used to appear as "Set up X…" rows so the
 * dropdown doubled as a discovery surface, but in practice that filled the picker with
 * models that could not be used — the ＋ button next to the picker is the setup entry
 * point, and a list of choices should contain only things that can actually be chosen.
 * A provider that IS configured but fails to list still gets its "unavailable" row:
 * that is information about something the user set up, not noise.
 */
export class ModelCatalogService {
  private cache: { at: number; models: ModelOptionDto[] } | undefined;

  constructor(
    private readonly factory: ProviderFactory,
    private readonly setup: ProviderSetupService = new ProviderSetupService(factory),
    /** Listings hit the network; a short memo keeps opening the dropdown cheap. */
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(): void {
    this.cache = undefined;
  }

  async list(force = false): Promise<ModelOptionDto[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.models;
    }

    const registry = this.factory.getRegistry();
    const store = this.factory.getStore();
    const models: ModelOptionDto[] = [];

    // Sequential rather than concurrent: a provider that is down costs a timeout, and
    // firing five of those at once makes the dropdown feel broken rather than slow.
    for (const descriptor of registry.chatCapable()) {
      const configured = await store.isConfigured(descriptor);
      if (!configured) continue;

      const field = chatModelField(descriptor);
      if (!field) continue;

      const base = {
        providerId: descriptor.id,
        providerLabel: descriptor.label,
        icon: descriptor.icon,
        available: true,
      };

      // A fixed list is known without any I/O.
      if (field.source.type === 'fixed') {
        models.push(
          ...field.source.options.map((option) => ({
            ...base,
            modelId: option.value,
            label: option.label,
            detail: option.detail ?? option.description,
          })),
        );
        continue;
      }

      try {
        const result = await this.setup.listModels(descriptor.id, field.id, store.read(descriptor));
        models.push(
          ...result.options.map((option) => ({
            ...base,
            modelId: option.value,
            label: option.label,
            detail: option.detail ?? option.description,
            caution: option.caution,
          })),
        );
      } catch {
        // A single unreachable provider must not empty the whole dropdown.
        models.push({
          ...base,
          modelId: '',
          label: `${descriptor.label} unavailable`,
          detail: 'Could not list models',
          available: false,
        });
      }
    }

    this.cache = { at: Date.now(), models };
    return models;
  }

  /** Current provider, model and mode, for the composer bar. Reads config only. */
  state(mode: 'implement' | 'plan' | 'explain') {
    const registry = this.factory.getRegistry();
    const id = this.factory.configuredProviderId;
    const descriptor = registry.get(id);

    if (!descriptor) {
      return { activeProviderId: id, activeProviderLabel: id, mode };
    }

    const field = descriptor.fields.find((f) => isModelField(f) && f.role !== 'embedding');
    const model = field ? this.factory.getStore().read(descriptor)[field.id] : undefined;

    return {
      activeProviderId: id,
      activeProviderLabel: descriptor.label,
      activeModelId: model === undefined ? undefined : String(model),
      mode,
    };
  }
}
