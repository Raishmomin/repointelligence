import * as vscode from 'vscode';
import { Logger } from '../../shared/Logger';
import { OllamaClient } from '../ollama/OllamaClient';
import { LlmProvider } from './types';
import {
  isModelField,
  ModelFieldSchema,
  ProviderCapabilities,
  ProviderConfigContext,
  ProviderField,
  ProviderId,
  WireProviderField,
  WireProviderSchema,
} from './descriptor.types';

/**
 * A provider describes *what configuration it needs*, and that single declaration drives
 * the setup wizard, the settings panel, and validation.
 *
 * The pure schema lives in `descriptor.types.ts` so the webview can import it; this module
 * adds the parts that need the extension host — `ProviderHost` and the descriptor's three
 * function slots.
 */

// Re-exported so existing imports of `./descriptor` keep working unchanged.
export * from './descriptor.types';

/**
 * Everything a provider may need to construct itself. Narrow on purpose, so nothing under
 * `providers/` has to import the service container.
 */
export interface ProviderHost {
  secrets: vscode.SecretStorage;
  config: ProviderConfigContext;
  logger: Logger;
  /** Long-lived clients owned by the container and shared across providers. */
  services: { ollamaClient: OllamaClient };
}

export interface InvalidatableProvider {
  /** Drop any cached client so the next call picks up a rotated key or changed URL. */
  invalidate(): void;
}

export interface EmbeddingProvider {
  readonly id: ProviderId;
  isAvailable(): Promise<boolean>;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  description: string;
  detail?: string;
  /** Codicon id, e.g. 'cloud'. */
  icon?: string;
  /** Linked from the setup flow, e.g. where to get an API key. */
  docsUrl?: string;

  /** Ordered — drives both the wizard sequence and the form layout. */
  fields: ProviderField[];

  capabilities: ProviderCapabilities;

  /** Higher wins when falling back and the user has not pinned an order. */
  fallbackRank: number;

  /**
   * Must not import a heavy SDK at module scope: `registry.ts` imports every descriptor, so
   * a top-level SDK import would load every provider's dependencies at activation.
   */
  create(host: ProviderHost): LlmProvider & Partial<InvalidatableProvider>;

  /** Present only when `capabilities.embeddings` is true. */
  createEmbedder?(host: ProviderHost): EmbeddingProvider;
}

/** The field whose value is the chat model, for the status bar and diagnostics. */
export function chatModelField(descriptor: ProviderDescriptor): ModelFieldSchema | undefined {
  return descriptor.fields.filter(isModelField).find((field) => field.role !== 'embedding');
}

/**
 * The serialisable projection sent to the webview. Strips the function slots and flattens a
 * dynamic model source to its metadata — the panel asks the host to run `list`.
 */
export function toWireSchema(descriptor: ProviderDescriptor): WireProviderSchema {
  return {
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description,
    detail: descriptor.detail,
    icon: descriptor.icon,
    docsUrl: descriptor.docsUrl,
    capabilities: descriptor.capabilities,
    fallbackRank: descriptor.fallbackRank,
    fields: descriptor.fields.map((field): WireProviderField => {
      if (!isModelField(field)) return field;
      const { source, ...rest } = field;
      return {
        ...rest,
        source:
          source.type === 'fixed'
            ? { type: 'fixed', options: source.options }
            : {
                type: 'dynamic',
                allowCustom: source.allowCustom,
                emptyMessage: source.emptyMessage,
              },
      };
    }),
  };
}
