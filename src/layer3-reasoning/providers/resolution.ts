import { LlmProvider, ProviderId } from './types';

export type ResolutionReason = 'configured' | 'fallback';

export interface AttemptedProvider {
  id: ProviderId;
  reason?: string;
}

/**
 * Which provider actually served a run, and why.
 *
 * Keeps `{ provider, notice? }` structurally intact so existing call sites compile
 * unchanged; everything else is additive. This exists because a fallback can silently swap
 * a cloud model for a local one mid-session — which is exactly the case where "I'm not sure
 * which backend was running" becomes an unanswerable question.
 */
export interface ProviderResolution {
  provider: LlmProvider;
  notice?: string;
  providerId: ProviderId;
  providerLabel: string;
  model?: string;
  reason: ResolutionReason;
  fallbackFrom?: ProviderId;
  attempted: AttemptedProvider[];
  resolvedAt: number;
}

export interface EmbeddingResolution {
  providerId: ProviderId;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Short-lived availability memo.
 *
 * Without it, resolving a provider probes every candidate over the network on every agent
 * run and every status bar refresh. Cleared whenever configuration or a secret changes, so
 * it can never mask a fix the user just made.
 */
export class AvailabilityCache {
  private readonly entries = new Map<ProviderId, { at: number; value: boolean }>();

  constructor(private readonly ttlMs = 5_000) {}

  async check(id: ProviderId, probe: () => Promise<boolean>): Promise<boolean> {
    const cached = this.entries.get(id);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.value;

    const value = await probe();
    this.entries.set(id, { at: Date.now(), value });
    return value;
  }

  delete(id: ProviderId): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Last known state without probing — for the status bar, which must never do I/O. */
  peek(id: ProviderId): boolean | undefined {
    return this.entries.get(id)?.value;
  }
}
