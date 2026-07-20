/**
 * Provider configuration schema — the parts with no `vscode` dependency.
 *
 * Split out from `descriptor.ts` so the webview can import them. `descriptor.ts` pulls in
 * `vscode`, `Logger` and `OllamaClient` for `ProviderHost`, none of which exist in a
 * webview context; importing it there would drag `@types/vscode` into the webview tsconfig
 * and fail at runtime.
 *
 * Everything here is JSON-serialisable except a dynamic model source's `list`. That is
 * load-bearing: `visibleWhen` is a data shape and `pattern` a regex *string* precisely so a
 * form can render without a round trip to the extension host per keystroke.
 */

export type ProviderId = string;

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

/** Read-side view of one provider's configuration, backed by draft or persisted values. */
export interface ProviderConfigContext {
  get(fieldId: string): string | number | undefined;
  getString(fieldId: string, fallback?: string): string;
  getNumber(fieldId: string, fallback: number): number;
  getSecret(fieldId: string): Promise<string | undefined>;
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

export interface ProviderCapabilities {
  chat: boolean;
  embeddings: boolean;
  nativeTools: boolean;
  /** No network or credentials needed — cheap and safe to probe often. */
  local: boolean;
}

// ── Wire projection ──────────────────────────────────────────

/** A model field with its function slot flattened to metadata, for transport. */
export interface WireModelField extends Omit<ModelFieldSchema, 'source'> {
  source:
    | { type: 'fixed'; options: ProviderOption[] }
    | { type: 'dynamic'; allowCustom: boolean; emptyMessage: string };
}

export type WireProviderField =
  | SecretFieldSchema
  | SettingFieldSchema
  | EnumFieldSchema
  | WireModelField;

export interface WireProviderSchema {
  id: ProviderId;
  label: string;
  description: string;
  detail?: string;
  icon?: string;
  docsUrl?: string;
  capabilities: ProviderCapabilities;
  fallbackRank: number;
  fields: WireProviderField[];
}

// ── Pure helpers ─────────────────────────────────────────────

export function isSecretField(field: ProviderField | WireProviderField): field is SecretFieldSchema {
  return field.kind === 'secret';
}

export function isModelField(field: ProviderField): field is ModelFieldSchema {
  return field.kind === 'model';
}

/** Applies `visibleWhen` against the values gathered so far. */
export function isFieldVisible(
  field: ProviderField | WireProviderField,
  values: FieldValues,
): boolean {
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
export function validateFieldFormat(
  field: ProviderField | WireProviderField,
  value: string,
): string | undefined {
  if (!field.pattern || !value) return undefined;
  return new RegExp(field.pattern).test(value) ? undefined : field.patternWarning;
}
