import * as vscode from 'vscode';
import { ServiceContainer } from '../../container';
import { EventBus } from '../../shared/EventBus';
import {
  FieldValues,
  isSecretField,
  ProviderDescriptor,
  ProviderField,
  validateFieldFormat,
} from '../../layer3-reasoning/providers/descriptor';
import { ProviderSetupService } from '../../layer3-reasoning/providers/ProviderSetupService';
import { ProviderId } from '../../layer3-reasoning/providers/types';

/**
 * Guided provider setup, driven entirely off the descriptor.
 *
 * Nothing here names a provider or knows what fields one has — a new provider gets this
 * flow for free from its descriptor alone.
 */
export async function chooseModelProvider(preselected?: ProviderId): Promise<void> {
  const container = ServiceContainer.getInstance();
  const factory = container.providerFactory;
  const registry = factory.getRegistry();
  const setup = new ProviderSetupService(factory);

  const id = preselected ?? (await pickProvider(setup, factory.configuredProviderId, registry.chatCapable()));
  if (!id) return;

  const descriptor = registry.require(id);
  const draft = await collectFields(descriptor, setup, registry);
  if (!draft) return; // user escaped — nothing is written

  if (!(await confirmValidation(descriptor, setup, draft))) return;

  await setup.save(id, draft);

  const model = draft[chatModelFieldId(descriptor) ?? ''];
  EventBus.getInstance().emit('provider:changed', {
    providerId: id,
    model: model === undefined ? undefined : String(model),
  });
  vscode.window.showInformationMessage(
    `Now using ${descriptor.label}${model ? ` with ${model}` : ''}.`,
  );
}

// ── Step 1: which provider ───────────────────────────────────

async function pickProvider(
  setup: ProviderSetupService,
  current: ProviderId,
  candidates: ProviderDescriptor[],
): Promise<ProviderId | undefined> {
  // Configured-state only — a picker must not make network calls just to open.
  const configured = await setup.configuredState();

  const items = candidates.map((descriptor) => ({
    label: `${descriptor.icon ? `$(${descriptor.icon}) ` : ''}${descriptor.label}`,
    description: [
      descriptor.id === current ? '$(check) current' : '',
      configured.get(descriptor.id) ? '' : '$(warning) not configured',
    ]
      .filter(Boolean)
      .join('  '),
    detail: descriptor.detail ?? descriptor.description,
    id: descriptor.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Choose Model Provider',
    placeHolder: 'Which backend should the coding agent use?',
    ignoreFocusOut: true,
  });
  return picked?.id;
}

// ── Step 2: the provider's own fields ────────────────────────

async function collectFields(
  descriptor: ProviderDescriptor,
  setup: ProviderSetupService,
  registry: ReturnType<ServiceContainer['providerFactory']['getRegistry']>,
): Promise<FieldValues | undefined> {
  const draft: FieldValues = {};

  // Re-read each iteration so `visibleWhen` reacts to what has been entered so far.
  for (let index = 0; index < registry.fieldsFor(descriptor.id, draft).length; index++) {
    const field = registry.fieldsFor(descriptor.id, draft)[index];
    const value = await promptForField(field, descriptor, setup, draft);
    if (value === undefined) return undefined; // escaped
    if (value !== '') draft[field.id] = value;
  }

  return draft;
}

/** @returns the entered value, `''` to leave unset, or `undefined` if the user escaped. */
async function promptForField(
  field: ProviderField,
  descriptor: ProviderDescriptor,
  setup: ProviderSetupService,
  draft: FieldValues,
): Promise<string | undefined> {
  if (field.kind === 'model') return promptForModel(field, descriptor, setup, draft);

  if (field.kind === 'enum') {
    const picked = await vscode.window.showQuickPick(
      field.options.map((option) => ({
        label: option.label,
        description: option.description,
        detail: option.detail,
        value: option.value,
      })),
      { title: field.label, placeHolder: field.description, ignoreFocusOut: true },
    );
    return picked?.value;
  }

  if (isSecretField(field)) {
    const stored = await setup.hasStoredSecret(field);
    const entered = await vscode.window.showInputBox({
      title: field.label,
      prompt: field.description,
      password: true,
      ignoreFocusOut: true,
      placeHolder: stored ? 'A key is stored — press Enter to keep it' : field.placeholder,
      validateInput: (value) => (value ? validateFieldFormat(field, value) : undefined),
    });
    if (entered === undefined) return undefined;
    // Blank with a key already stored means "keep it", not "clear it".
    if (!entered && stored) return '';
    if (!entered && field.required) {
      vscode.window.showWarningMessage(`${field.label} is required.`);
      return undefined;
    }
    return entered;
  }

  const current = draft[field.id] ?? ('default' in field ? field.default : undefined);
  const entered = await vscode.window.showInputBox({
    title: field.label,
    prompt: field.description,
    value: current === undefined ? '' : String(current),
    ignoreFocusOut: true,
    placeHolder: field.placeholder,
    validateInput: (value) => {
      if (field.required && !value) return `${field.label} is required.`;
      if (field.kind === 'number' && value && !Number.isFinite(Number(value))) {
        return 'Enter a number.';
      }
      return validateFieldFormat(field, value);
    },
  });
  return entered;
}

async function promptForModel(
  field: Extract<ProviderField, { kind: 'model' }>,
  descriptor: ProviderDescriptor,
  setup: ProviderSetupService,
  draft: FieldValues,
): Promise<string | undefined> {
  const CUSTOM = '__custom__';

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Loading models for ${descriptor.label}…` },
    () => setup.listModels(descriptor.id, field.id, draft),
  );

  if (!result.options.length) {
    if (!result.allowCustom) {
      vscode.window.showErrorMessage(result.error ?? 'No models are available.');
      return undefined;
    }
    vscode.window.showWarningMessage(result.error ?? 'Could not list models; enter one manually.');
    return vscode.window.showInputBox({
      title: field.label,
      value: field.default === undefined ? '' : String(field.default),
      ignoreFocusOut: true,
    });
  }

  const items = result.options.map((option) => ({
    label: option.label,
    description: option.description,
    detail: option.detail,
    value: option.value,
  }));
  if (result.allowCustom) {
    items.push({
      label: '$(edit) Enter a model name…',
      description: undefined,
      detail: 'For a model not installed yet',
      value: CUSTOM,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: field.label,
    placeHolder: field.description,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;

  if (picked.value === CUSTOM) {
    return vscode.window.showInputBox({
      title: field.label,
      placeHolder: field.default === undefined ? undefined : String(field.default),
      ignoreFocusOut: true,
    });
  }
  return picked.value;
}

// ── Step 3: prove it works before saving ─────────────────────

async function confirmValidation(
  descriptor: ProviderDescriptor,
  setup: ProviderSetupService,
  draft: FieldValues,
): Promise<boolean> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking ${descriptor.label}…` },
    () => setup.validate(descriptor.id, draft),
  );
  if (result.ok) return true;

  const choice = await vscode.window.showWarningMessage(
    `${descriptor.label} is not reachable: ${result.message}`,
    { modal: true },
    'Save anyway',
  );
  // Saving anyway is a legitimate choice — the credentials may be for a server that is
  // simply not running yet, and the fallback chain covers it at run time.
  return choice === 'Save anyway';
}

function chatModelFieldId(descriptor: ProviderDescriptor): string | undefined {
  return descriptor.fields.find((field) => field.kind === 'model' && field.role !== 'embedding')?.id;
}
