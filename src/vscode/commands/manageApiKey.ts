import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { ProviderSetupService } from '../../layer3-reasoning/providers/ProviderSetupService';
import { ProviderDescriptor, validateFieldFormat } from '../../layer3-reasoning/providers/descriptor';
import { chooseModelProvider } from './chooseModelProvider';

/**
 * Key management for whichever provider is active.
 *
 * Kept as its own command because rotating a key is a common, narrow task that should not
 * require walking the whole setup wizard — but it shares the same store and the same
 * SecretStorage keys, declared by each provider's descriptor.
 */
export async function setApiKey(): Promise<void> {
  const container = ServiceContainer.getInstance();
  const factory = container.providerFactory;
  const setup = new ProviderSetupService(factory);
  const registry = factory.getRegistry();

  const descriptor = await pickProviderWithSecrets(registry.chatCapable(), setup, factory.configuredProviderId);
  if (!descriptor) return;

  const fields = setup.secretFieldsOf(descriptor);
  if (!fields.length) {
    // Nothing to do here, but the user clearly wants to configure this provider.
    vscode.window.showInformationMessage(`${descriptor.label} does not use an API key.`);
    return chooseModelProvider(descriptor.id);
  }

  for (const field of fields) {
    const stored = await setup.hasStoredSecret(field);
    const entered = await vscode.window.showInputBox({
      title: `${descriptor.label} — ${field.label}`,
      prompt: field.description ?? 'Stored in the OS keychain, never in settings.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: stored ? 'A key is stored — press Enter to keep it' : field.placeholder,
      validateInput: (value) => (value ? validateFieldFormat(field, value) : undefined),
    });

    if (entered === undefined) return; // escaped
    // Blank with a key already stored means keep it, so Enter never wipes a working key.
    if (entered) await factory.getStore().writeSecret(field, entered);
  }

  factory.invalidate(descriptor.id);
  vscode.window.showInformationMessage(`${descriptor.label} API key saved.`);
}

export async function clearApiKey(): Promise<void> {
  const container = ServiceContainer.getInstance();
  const factory = container.providerFactory;
  const setup = new ProviderSetupService(factory);
  const registry = factory.getRegistry();

  const descriptor = await pickProviderWithSecrets(registry.chatCapable(), setup, factory.configuredProviderId);
  if (!descriptor || !setup.secretFieldsOf(descriptor).length) return;

  const confirmed = await vscode.window.showWarningMessage(
    `Remove the stored credentials for ${descriptor.label}?`,
    { modal: true },
    'Remove',
  );
  if (confirmed !== 'Remove') return;

  await factory.getStore().clearSecrets(descriptor);
  factory.invalidate(descriptor.id);
  vscode.window.showInformationMessage(`${descriptor.label} credentials removed.`);
}

/** Skips the picker when only one provider actually uses secrets. */
async function pickProviderWithSecrets(
  candidates: ProviderDescriptor[],
  setup: ProviderSetupService,
  current: string,
): Promise<ProviderDescriptor | undefined> {
  const withSecrets = candidates.filter((descriptor) => setup.secretFieldsOf(descriptor).length > 0);
  if (withSecrets.length === 0) {
    vscode.window.showInformationMessage('No configured provider uses an API key.');
    return undefined;
  }
  if (withSecrets.length === 1) return withSecrets[0];

  const picked = await vscode.window.showQuickPick(
    withSecrets.map((descriptor) => ({
      label: `${descriptor.icon ? `$(${descriptor.icon}) ` : ''}${descriptor.label}`,
      description: descriptor.id === current ? '$(check) current' : undefined,
      descriptor,
    })),
    { title: 'Which provider?', ignoreFocusOut: true },
  );
  return picked?.descriptor;
}
