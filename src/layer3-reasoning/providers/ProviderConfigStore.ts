import * as vscode from 'vscode';
import {
  FieldValues,
  isSecretField,
  ProviderConfigContext,
  ProviderDescriptor,
  ProviderField,
  SecretFieldSchema,
} from './descriptor';
import { ProviderId } from './types';

const SECTION = 'repo-intelligence';
const PROVIDERS_KEY = 'providers';

type ProvidersSetting = Record<string, Record<string, string | number>>;

/**
 * Reads and writes per-provider configuration.
 *
 * All provider settings live under one declared object, `repo-intelligence.providers`,
 * keyed by provider id. This is not a stylistic choice: **VS Code cannot register
 * configuration keys at runtime**, and `config.update()` on an undeclared key throws. Flat
 * per-provider keys would therefore force a package.json edit for every new provider,
 * which is exactly what the registry exists to avoid.
 *
 * Secrets never appear here — they live in SecretStorage, addressed by the field's own
 * `secretKey`.
 */
export class ProviderConfigStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  // ── Reading ────────────────────────────────────────────────

  /**
   * Resolution order per field: `providers.<id>.<field>` → the field's `legacySettingKey`
   * → its default. The legacy step is what keeps a user's existing
   * `repo-intelligence.ollama.chatModel` working after the registry lands.
   */
  read(descriptor: ProviderDescriptor): FieldValues {
    const config = vscode.workspace.getConfiguration(SECTION);
    const stored = config.get<ProvidersSetting>(PROVIDERS_KEY, {})[descriptor.id] ?? {};
    const values: FieldValues = {};

    for (const field of descriptor.fields) {
      if (isSecretField(field)) continue;

      if (stored[field.id] !== undefined) {
        values[field.id] = stored[field.id];
        continue;
      }

      const legacyKey = 'legacySettingKey' in field ? field.legacySettingKey : undefined;
      const legacy = legacyKey ? config.get<string | number>(legacyKey) : undefined;
      values[field.id] = legacy ?? ('default' in field ? field.default : undefined);
    }

    return values;
  }

  /** A context bound to persisted values. */
  context(descriptor: ProviderDescriptor): ProviderConfigContext {
    return this.makeContext(descriptor, this.read(descriptor));
  }

  /**
   * A context layering unsaved draft values over persisted ones.
   *
   * This is what a dynamic model list must be given: it needs the base URL or key the user
   * typed thirty seconds ago and has not saved. Reading `getConfiguration()` there would
   * silently list models for the *previous* host.
   */
  draftContext(descriptor: ProviderDescriptor, draft: FieldValues): ProviderConfigContext {
    return this.makeContext(descriptor, { ...this.read(descriptor), ...draft }, draft);
  }

  private makeContext(
    descriptor: ProviderDescriptor,
    values: FieldValues,
    draft?: FieldValues,
  ): ProviderConfigContext {
    return {
      get: (fieldId) => values[fieldId],
      getString: (fieldId, fallback = '') => {
        const value = values[fieldId];
        return value === undefined || value === '' ? fallback : String(value);
      },
      getNumber: (fieldId, fallback) => {
        const value = Number(values[fieldId]);
        return Number.isFinite(value) ? value : fallback;
      },
      getSecret: async (fieldId) => {
        const field = descriptor.fields.find((candidate) => candidate.id === fieldId);
        if (!field || !isSecretField(field)) return undefined;
        // A secret typed into the wizard but not yet stored still has to reach `list`.
        const drafted = draft?.[fieldId];
        if (typeof drafted === 'string' && drafted) return drafted;
        return this.secrets.get(field.secretKey);
      },
    };
  }

  // ── Writing ────────────────────────────────────────────────

  /**
   * Persists one provider's settings.
   *
   * `config.update` on an object **replaces it wholesale**, so this reads the current value
   * for the target scope, splices this provider's entry in, and writes the merged object
   * back. Writing naively would wipe every other provider's configuration.
   */
  async write(descriptor: ProviderDescriptor, values: FieldValues): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const inspected = config.inspect<ProvidersSetting>(PROVIDERS_KEY);

    // Follow whichever scope already carries a value; object settings do not deep-merge
    // across scopes, so a workspace entry would otherwise shadow a global write silently.
    const target =
      inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    const base =
      target === vscode.ConfigurationTarget.Workspace
        ? inspected?.workspaceValue
        : inspected?.globalValue;

    // Checked against the caller's input, not the entry built below: skipping secrets in
    // the loop already prevents the leak, so asserting on the output would only ever fire
    // if that loop changed. Asserting on the input catches the actual mistake — a caller
    // handing us a secret, or a field mis-declared as a setting — at the point it happens.
    assertNoSecrets(descriptor, values);

    const entry: Record<string, string | number> = {};
    for (const field of descriptor.fields) {
      if (isSecretField(field)) continue;
      const value = values[field.id];
      if (value !== undefined && value !== '') entry[field.id] = value;
    }

    await config.update(PROVIDERS_KEY, { ...(base ?? {}), [descriptor.id]: entry }, target);
  }

  async writeSecret(field: SecretFieldSchema, value: string): Promise<void> {
    await this.secrets.store(field.secretKey, value);
  }

  async clearSecrets(descriptor: ProviderDescriptor): Promise<void> {
    for (const field of descriptor.fields) {
      if (isSecretField(field)) await this.secrets.delete(field.secretKey);
    }
  }

  async hasSecret(field: SecretFieldSchema): Promise<boolean> {
    return !!(await this.secrets.get(field.secretKey));
  }

  // ── Readiness ──────────────────────────────────────────────

  /**
   * Whether every required field has a value. Deliberately does no I/O beyond SecretStorage
   * so the fallback chain can skip unconfigured providers without a network probe each.
   */
  async isConfigured(descriptor: ProviderDescriptor): Promise<boolean> {
    const values = this.read(descriptor);
    for (const field of descriptor.fields) {
      if (!field.required) continue;
      if (isSecretField(field)) {
        if (!(await this.hasSecret(field))) return false;
      } else if (values[field.id] === undefined || values[field.id] === '') {
        return false;
      }
    }
    return true;
  }

  /** Active provider id as configured, unvalidated. */
  static configuredProviderId(): ProviderId {
    return vscode.workspace.getConfiguration(SECTION).get<string>('provider', 'anthropic');
  }

  static async setActiveProvider(id: ProviderId): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const inspected = config.inspect<string>('provider');
    const target =
      inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update('provider', id, target);
  }
}

/**
 * Guards the one mistake in this file that would be genuinely damaging: a mis-declared
 * field putting an API key into settings.json, which syncs and gets committed.
 */
function assertNoSecrets(descriptor: ProviderDescriptor, values: FieldValues): void {
  const secretIds = descriptor.fields.filter(isSecretField).map((field: ProviderField) => field.id);
  const leaked = secretIds.filter((id) => values[id] !== undefined && values[id] !== '');
  if (leaked.length) {
    throw new Error(
      `Refusing to write secret field(s) [${leaked.join(', ')}] for provider ` +
        `"${descriptor.id}" into settings. Secrets belong in SecretStorage only.`,
    );
  }
}
