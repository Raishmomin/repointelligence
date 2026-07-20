import * as vscode from 'vscode';
import { Logger } from '../../shared/Logger';
import { isSecretField, ProviderDescriptor } from './descriptor';
import { ProviderConfigStore } from './ProviderConfigStore';
import { ProviderRegistry } from './ProviderRegistry';

const MIGRATION_FLAG = 'repo-intelligence.providerConfigMigrated.v1';

/**
 * Copies pre-registry flat settings into the per-provider object, once.
 *
 * Reads already fall back to the legacy keys, so this is not strictly required for things
 * to work — it exists so that the first time a user opens the setup flow, their existing
 * choices are already filled in rather than silently replaced by defaults.
 *
 * The old keys are deliberately left in place and still declared: a user may roll back, and
 * their settings.json should keep working when they do.
 */
export async function migrateLegacyProviderConfig(
  context: vscode.ExtensionContext,
  registry: ProviderRegistry,
  store: ProviderConfigStore,
  logger: Logger = Logger.getInstance(),
): Promise<void> {
  if (context.globalState.get<boolean>(MIGRATION_FLAG)) return;

  const config = vscode.workspace.getConfiguration('repo-intelligence');
  const migrated: string[] = [];

  for (const descriptor of registry.all()) {
    const values = collectLegacyValues(descriptor, config);
    if (!Object.keys(values).length) continue;

    try {
      await store.write(descriptor, values);
      migrated.push(descriptor.id);
    } catch (error) {
      // A failed migration must never block activation — reads still fall back to the
      // legacy keys, so the user simply keeps working with their old settings.
      logger.warn(`Could not migrate settings for ${descriptor.id}`, { error: String(error) });
    }
  }

  await context.globalState.update(MIGRATION_FLAG, true);
  if (migrated.length) {
    logger.info(`Migrated provider settings for: ${migrated.join(', ')}`);
  }
}

/**
 * Only picks up values the user explicitly set. Copying defaults across would freeze
 * today's defaults into their settings, so a future change to a default would never
 * reach them.
 */
function collectLegacyValues(
  descriptor: ProviderDescriptor,
  config: vscode.WorkspaceConfiguration,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};

  for (const field of descriptor.fields) {
    if (isSecretField(field)) continue; // secrets were already in SecretStorage under the same key

    const legacyKey = 'legacySettingKey' in field ? field.legacySettingKey : undefined;
    if (!legacyKey) continue;

    const inspected = config.inspect<string | number>(legacyKey);
    const explicit = inspected?.workspaceValue ?? inspected?.globalValue;
    if (explicit !== undefined && explicit !== '') values[field.id] = explicit;
  }

  return values;
}
