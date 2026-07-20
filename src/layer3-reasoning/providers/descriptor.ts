import * as vscode from 'vscode';
import { Logger } from '../../shared/Logger';
import { OllamaClient } from '../ollama/OllamaClient';
import { LlmProvider, ProviderId } from './types';

/**
 * A provider describes *what configuration it needs*, and that single declaration drives
 * the setup wizard, the future React settings panel, and validation.
 *
 * Everything here is JSON-serialisable except three named function slots (`create`,
 * `createEmbedder`, and a dynamic model source's `list`). That constraint is load-bearing:
 * `visibleWhen` is a data shape and `pattern` a regex *string* precisely so the webview can
 * render a form without a round trip to the extension host per keystroke. Making either a
 * closure would force a schema rewrite later.
 */

// ── Field schema ─────────────────────────────────────────────

export interface ProviderOption {
  value: string;
  label: string;
  description?: string;
  detail?: string;
}

/** Serialisable conditional visibility. Deliberately data, not a predicate function. */
export interface VisibleWhen {
  field: string;
  /** Show only when the referenced field has a non-empty value. */
  isSet?: boolean;
  /** …or when it equals one of these. */
  equals?: string[];
}

interface FieldBase {
  id: string;
  label: string;
  description?: string;
  required: boolean;
  placeholder?: string;
  visibleWhen?: VisibleWhen;
  /** Regex *source*, so it survives JSON. Advisory only — never blocks submission. */
  pattern?: string;
  patternWarning?: string;
}

export interface SecretFieldSchema extends FieldBase {
  kind: 'secret';
  /**
   * The full SecretStorage key, stated rather than derived, so keys already in a user's
   * keychain keep working verbatim.
   */
  secretKey: string;
}

export interface SettingFieldSchema extends FieldBase {
  kind: 'string' | 'url' | 'number';
  default?: string | number;
  /** Pre-registry flat key, read as a fallback so existing settings keep working. */
  legacySettingKey?: string;
}

export interface EnumFieldSchema extends FieldBase {
  kind: 'enum';
  options: ProviderOption[];
  default?: string;
  legacySettingKey?: string;
}

export type ModelSource =
  | { type: 'fixed'; options: ProviderOption[] }
  | {
      type: 'dynamic';
      /**
       * Runs against the in-progress draft, never persisted config — the user may have
       * just typed a base URL or key that has not been saved yet.
       */
      list(context: ProviderConfigContext): Promise<ProviderOption[]>;
      allowCustom: boolean;
      emptyMessage: string;
    };

export interface ModelFieldSchema extends FieldBase {
  kind: 'model';
  source: ModelSource;
  default?: string;
  legacySettingKey?: string;
  /** Marks the field the status bar and run diagnostics report. */
  role?: 'chat' | 'embedding';
}

export type ProviderField =
  | SecretFieldSchema
  | SettingFieldSchema
  | EnumFieldSchema
  | ModelFieldSchema;

export type FieldValues = Record<string, string | number | undefined>;

// ── Runtime plumbing ─────────────────────────────────────────

/** Read-side view of one provider's configuration, backed by draft or persisted values. */
export interface ProviderConfigContext {
  get(fieldId: string): string | number | undefined;
  getString(fieldId: string, fallback?: string): string;
  getNumber(fieldId: string, fallback: number): number;
  getSecret(fieldId: string): Promise<string | undefined>;
}

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

// ── The descriptor ───────────────────────────────────────────

export interface ProviderCapabilities {
  chat: boolean;
  embeddings: boolean;
  nativeTools: boolean;
  /** No network or credentials needed — cheap and safe to probe often. */
  local: boolean;
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

// ── Helpers ──────────────────────────────────────────────────

export function isSecretField(field: ProviderField): field is SecretFieldSchema {
  return field.kind === 'secret';
}

export function isModelField(field: ProviderField): field is ModelFieldSchema {
  return field.kind === 'model';
}

/** The field whose value is the chat model, for the status bar and diagnostics. */
export function chatModelField(descriptor: ProviderDescriptor): ModelFieldSchema | undefined {
  return descriptor.fields.filter(isModelField).find((field) => field.role !== 'embedding');
}

/** Applies `visibleWhen` against the values gathered so far. */
export function isFieldVisible(field: ProviderField, values: FieldValues): boolean {
  const condition = field.visibleWhen;
  if (!condition) return true;

  const value = values[condition.field];
  if (condition.isSet !== undefined) {
    const present = value !== undefined && value !== '';
    if (present !== condition.isSet) return false;
  }
  if (condition.equals && !condition.equals.includes(String(value ?? ''))) return false;
  return true;
}

/** Advisory format check. Never blocks — key formats change, and a valid key must not be refused. */
export function validateFieldFormat(field: ProviderField, value: string): string | undefined {
  if (!field.pattern || !value) return undefined;
  return new RegExp(field.pattern).test(value) ? undefined : field.patternWarning;
}

/**
 * The serialisable projection sent to the webview. Strips the three function slots and
 * flattens a dynamic model source to its metadata — the panel asks the host to run `list`.
 */
export interface WireProviderField extends Omit<ModelFieldSchema, 'source'> {
  source?:
    | { type: 'fixed'; options: ProviderOption[] }
    | { type: 'dynamic'; allowCustom: boolean; emptyMessage: string };
}

export interface WireProviderSchema {
  id: ProviderId;
  label: string;
  description: string;
  detail?: string;
  icon?: string;
  docsUrl?: string;
  capabilities: ProviderCapabilities;
  fallbackRank: number;
  fields: Array<ProviderField | WireProviderField>;
}

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
    fields: descriptor.fields.map((field) => {
      if (!isModelField(field)) return field;
      const { source, ...rest } = field;
      return {
        ...rest,
        source:
          source.type === 'fixed'
            ? { type: 'fixed' as const, options: source.options }
            : {
                type: 'dynamic' as const,
                allowCustom: source.allowCustom,
                emptyMessage: source.emptyMessage,
              },
      };
    }),
  };
}
