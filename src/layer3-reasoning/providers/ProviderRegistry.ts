import {
  FieldValues,
  isFieldVisible,
  ProviderDescriptor,
  ProviderField,
} from './descriptor';
import { PROVIDER_DESCRIPTORS } from './registry';
import { ProviderId } from './types';

/**
 * Lookup and ordering over the registered providers.
 *
 * Descriptors are injected rather than read from the module singleton, so tests can build
 * a registry of fakes and prove the "one file, one entry" contract without touching the
 * real providers.
 */
export class ProviderRegistry {
  private readonly byId: Map<ProviderId, ProviderDescriptor>;

  constructor(private readonly descriptors: ProviderDescriptor[] = PROVIDER_DESCRIPTORS) {
    assertUniqueIds(descriptors);
    this.byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  }

  all(): ProviderDescriptor[] {
    return [...this.descriptors];
  }

  get(id: ProviderId): ProviderDescriptor | undefined {
    return this.byId.get(id);
  }

  /**
   * Widening `ProviderId` to `string` gave up exhaustiveness checking, so an unknown id
   * must fail loudly and say what the valid ones are rather than silently defaulting.
   */
  require(id: ProviderId): ProviderDescriptor {
    const descriptor = this.byId.get(id);
    if (!descriptor) {
      throw new Error(
        `Unknown model provider "${id}". Registered providers: ${this.ids().join(', ')}.`,
      );
    }
    return descriptor;
  }

  ids(): ProviderId[] {
    return this.descriptors.map((descriptor) => descriptor.id);
  }

  chatCapable(): ProviderDescriptor[] {
    return this.descriptors.filter((descriptor) => descriptor.capabilities.chat);
  }

  /** Embedding-capable *and* actually able to build an embedder. */
  embedCapable(): ProviderDescriptor[] {
    return this.descriptors.filter(
      (descriptor) => descriptor.capabilities.embeddings && !!descriptor.createEmbedder,
    );
  }

  /** Descending rank, ties broken by id so the order is stable across runs. */
  byFallbackRank(): ProviderDescriptor[] {
    return [...this.descriptors].sort(
      (a, b) => b.fallbackRank - a.fallbackRank || a.id.localeCompare(b.id),
    );
  }

  /** Fields to present, with `visibleWhen` applied against what has been gathered so far. */
  fieldsFor(id: ProviderId, values: FieldValues = {}): ProviderField[] {
    return this.require(id).fields.filter((field) => isFieldVisible(field, values));
  }
}

function assertUniqueIds(descriptors: ProviderDescriptor[]): void {
  const seen = new Set<ProviderId>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) {
      // Thrown at construction rather than at first use, so a duplicate is a startup
      // failure with an obvious cause instead of one provider silently shadowing another.
      throw new Error(`Duplicate provider id "${descriptor.id}" in the registry.`);
    }
    seen.add(descriptor.id);
  }
}
