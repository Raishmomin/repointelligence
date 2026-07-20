import * as vscode from 'vscode';
import { EventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { OllamaClient } from '../ollama/OllamaClient';
import {
  chatModelField,
  InvalidatableProvider,
  isSecretField,
  ProviderDescriptor,
  ProviderHost,
} from './descriptor';
import { ProviderConfigStore } from './ProviderConfigStore';
import { ProviderRegistry } from './ProviderRegistry';
import {
  AttemptedProvider,
  AvailabilityCache,
  EmbeddingResolution,
  ProviderResolution,
} from './resolution';
import { LlmProvider, ProviderId } from './types';

/**
 * Resolves which provider serves a request.
 *
 * Entirely registry-driven: no provider is named anywhere in this file, so adding one
 * requires no change here.
 */
export class ProviderFactory implements vscode.Disposable {
  private readonly instances = new Map<ProviderId, LlmProvider>();
  private readonly availability = new AvailabilityCache();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly ollamaClient: OllamaClient,
    private readonly registry: ProviderRegistry = new ProviderRegistry(),
    private readonly store: ProviderConfigStore = new ProviderConfigStore(secrets),
    private readonly logger: Logger = Logger.getInstance(),
    private readonly events: EventBus = EventBus.getInstance(),
  ) {
    this.subscriptions.push(
      secrets.onDidChange((event) => {
        // Descriptor-driven: whichever provider declared this secret key is the one whose
        // cached client is now stale.
        for (const descriptor of this.registry.all()) {
          const owns = descriptor.fields.some(
            (field) => isSecretField(field) && field.secretKey === event.key,
          );
          if (owns) this.invalidate(descriptor.id);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('repo-intelligence.provider')) {
          this.availability.clear();
        }
        if (event.affectsConfiguration('repo-intelligence.providers')) {
          this.instances.clear();
          this.availability.clear();
          this.ollamaClient.updateConfig();
        }
        // Legacy flat sections, until the migration is retired.
        if (event.affectsConfiguration('repo-intelligence.ollama')) {
          this.ollamaClient.updateConfig();
          this.invalidate('ollama');
        }
        if (event.affectsConfiguration('repo-intelligence.anthropic')) {
          this.invalidate('anthropic');
        }
      }),
    );
  }

  // ── Lookup ─────────────────────────────────────────────────

  /** The configured id, or the top-ranked provider when it names something unregistered. */
  get configuredProviderId(): ProviderId {
    const configured = ProviderConfigStore.configuredProviderId();
    if (this.registry.get(configured)) return configured;

    const fallback = this.registry.byFallbackRank()[0];
    this.logger.warn(
      `Configured provider "${configured}" is not registered; using "${fallback.id}".`,
    );
    return fallback.id;
  }

  instance(id: ProviderId): LlmProvider {
    const existing = this.instances.get(id);
    if (existing) return existing;

    const descriptor = this.registry.require(id);
    const created = descriptor.create(this.hostFor(descriptor));
    this.instances.set(id, created);
    return created;
  }

  getChatProvider(): LlmProvider {
    return this.instance(this.configuredProviderId);
  }

  private hostFor(descriptor: ProviderDescriptor): ProviderHost {
    return {
      secrets: this.secrets,
      config: this.store.context(descriptor),
      logger: this.logger,
      services: { ollamaClient: this.ollamaClient },
    };
  }

  invalidate(id: ProviderId): void {
    const instance = this.instances.get(id) as Partial<InvalidatableProvider> | undefined;
    if (instance?.invalidate) instance.invalidate();
    else this.instances.delete(id);
    this.availability.delete(id);
  }

  // ── Resolution ─────────────────────────────────────────────

  /**
   * The configured provider if usable, otherwise the best available alternative.
   *
   * Candidates are filtered by `isConfigured()` first, which touches only settings and
   * SecretStorage — so an unconfigured provider never costs a network probe.
   */
  async resolveChatProvider(): Promise<ProviderResolution | undefined> {
    const preferredId = this.configuredProviderId;
    const preferred = this.instance(preferredId);

    if (await this.availability.check(preferredId, () => preferred.isAvailable())) {
      return this.record(preferredId, preferred, { reason: 'configured', attempted: [] });
    }

    const preferredReason = await preferred.unavailableReason();
    const attempted: AttemptedProvider[] = [{ id: preferredId, reason: preferredReason }];

    const mode = vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<'auto' | 'off'>('providerFallback', 'auto');

    if (mode === 'off') {
      this.logger.error(
        `Provider "${preferredId}" is unavailable and fallback is off. ${preferredReason ?? ''}`,
      );
      return undefined;
    }

    for (const descriptor of this.fallbackCandidates(preferredId)) {
      if (!(await this.store.isConfigured(descriptor))) {
        attempted.push({ id: descriptor.id, reason: 'not configured' });
        continue;
      }

      const candidate = this.instance(descriptor.id);
      if (await this.availability.check(descriptor.id, () => candidate.isAvailable())) {
        return this.record(descriptor.id, candidate, {
          reason: 'fallback',
          fallbackFrom: preferredId,
          notice: `${preferredReason ?? `${preferredId} is unavailable.`} Falling back to ${descriptor.label}.`,
          attempted,
        });
      }
      attempted.push({ id: descriptor.id, reason: await candidate.unavailableReason() });
    }

    this.logger.error('No language model provider is available.', { attempted });
    return undefined;
  }

  /** Explicit user order if pinned, else descending rank. Never includes the excluded id. */
  private fallbackCandidates(exclude: ProviderId): ProviderDescriptor[] {
    const pinned = vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<string[]>('providerFallbackOrder', []);

    const ordered = pinned.length
      ? pinned
          .map((id) => this.registry.get(id))
          .filter((descriptor): descriptor is ProviderDescriptor => !!descriptor)
      : this.registry.byFallbackRank();

    return ordered.filter(
      (descriptor) => descriptor.id !== exclude && descriptor.capabilities.chat,
    );
  }

  private record(
    id: ProviderId,
    provider: LlmProvider,
    parts: Pick<ProviderResolution, 'reason' | 'attempted'> &
      Partial<Pick<ProviderResolution, 'notice' | 'fallbackFrom'>>,
  ): ProviderResolution {
    const descriptor = this.registry.require(id);
    const model = provider.modelId ?? this.configuredModelFor(descriptor);

    const resolution: ProviderResolution = {
      provider,
      providerId: id,
      providerLabel: descriptor.label,
      model,
      resolvedAt: Date.now(),
      ...parts,
    };

    this.logger.info(
      `Model provider resolved: ${id}/${model ?? 'unknown model'} (${parts.reason})`,
    );
    this.events.emit('provider:resolved', {
      providerId: id,
      providerLabel: descriptor.label,
      model,
      reason: parts.reason,
      fallbackFrom: parts.fallbackFrom,
    });

    return resolution;
  }

  /** Falls back to the descriptor's declared chat-model field when a provider omits `modelId`. */
  private configuredModelFor(descriptor: ProviderDescriptor): string | undefined {
    const field = chatModelField(descriptor);
    if (!field) return undefined;
    const value = this.store.read(descriptor)[field.id];
    return value === undefined ? undefined : String(value);
  }

  // ── Embeddings ─────────────────────────────────────────────

  /**
   * Picks an embedding-capable provider, preferring the chat provider when it can embed so
   * a second backend is not involved unnecessarily. Independent of the chat provider
   * otherwise — Anthropic has no embeddings endpoint, so a Claude user still embeds locally.
   */
  async resolveEmbeddingProvider(): Promise<EmbeddingResolution | undefined> {
    const chatId = this.configuredProviderId;
    const capable = this.registry.embedCapable();
    const ordered = [
      ...capable.filter((descriptor) => descriptor.id === chatId),
      ...capable
        .filter((descriptor) => descriptor.id !== chatId)
        .sort((a, b) => b.fallbackRank - a.fallbackRank),
    ];

    for (const descriptor of ordered) {
      if (!(await this.store.isConfigured(descriptor))) continue;
      const embedder = descriptor.createEmbedder!(this.hostFor(descriptor));
      if (await embedder.isAvailable()) {
        return { providerId: descriptor.id, embed: (texts) => embedder.embed(texts) };
      }
    }

    this.logger.info('No embedding provider available; retrieval stays keyword-only.');
    return undefined;
  }

  // ── Introspection for the setup UI ─────────────────────────

  getRegistry(): ProviderRegistry {
    return this.registry;
  }

  getStore(): ProviderConfigStore {
    return this.store;
  }

  // Exposed so ProviderSetupService can build a throwaway provider from an unsaved draft,
  // which is the only way to validate a configuration before committing it.
  getSecrets(): vscode.SecretStorage {
    return this.secrets;
  }

  getLogger(): Logger {
    return this.logger;
  }

  getServices(): ProviderHost['services'] {
    return { ollamaClient: this.ollamaClient };
  }

  /** Cached availability for the status bar, which must never trigger a probe. */
  peekAvailability(id: ProviderId): boolean | undefined {
    return this.availability.peek(id);
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}
