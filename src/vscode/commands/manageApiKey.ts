import * as vscode from 'vscode';
import { ANTHROPIC_SECRET_KEY } from '../../layer3-reasoning/providers/AnthropicProvider';

/**
 * Stores the Anthropic API key in VS Code's SecretStorage — the OS keychain — rather than
 * settings.json, which syncs across machines and is routinely committed to repositories.
 */
export async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'Anthropic API Key',
    prompt: 'Stored securely in VS Code SecretStorage, never in settings or the workspace.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-ant-...',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return 'A key is required.';
      // Advisory only — key formats change, so this must not hard-block a valid key.
      if (!trimmed.startsWith('sk-ant-')) return 'Anthropic keys normally begin with "sk-ant-".';
      return undefined;
    },
  });

  if (!key) return;

  await context.secrets.store(ANTHROPIC_SECRET_KEY, key.trim());
  vscode.window.showInformationMessage('Anthropic API key saved.');
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    'Remove the stored Anthropic API key?',
    { modal: true },
    'Remove',
  );
  if (confirmed !== 'Remove') return;

  await context.secrets.delete(ANTHROPIC_SECRET_KEY);
  vscode.window.showInformationMessage('Anthropic API key removed.');
}
