import * as vscode from 'vscode';
import { EventBus } from '../../shared/EventBus';
import { COMMANDS } from '../../shared/constants';
import { ProviderFactory } from '../../layer3-reasoning/providers/ProviderFactory';

/**
 * Shows which model backend is actually in play.
 *
 * A separate status bar item from `StatusBarManager`, which already saturates its single
 * item with scan and index progress — the two would otherwise overwrite each other.
 *
 * The fallback state is the reason this exists. Without it, a run configured for Claude
 * that quietly fell back to a small local model looks identical to one that did not, and
 * "which backend was running?" becomes unanswerable after the fact.
 */
export class ProviderStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly factory: ProviderFactory,
    events: EventBus = EventBus.getInstance(),
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = COMMANDS.CHOOSE_MODEL_PROVIDER;

    this.unsubscribes.push(
      events.on('provider:changed', () => void this.showConfigured()),
      // What actually served a run, which may differ from what is configured.
      events.on('provider:resolved', (payload) => {
        if (payload.reason === 'fallback') this.showFallback(payload);
        else this.showActive(payload.providerLabel, payload.model);
      }),
    );

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('repo-intelligence.provider') ||
          event.affectsConfiguration('repo-intelligence.providers')
        ) {
          void this.showConfigured();
        }
      }),
    );

    void this.showConfigured();
    this.item.show();
  }

  /**
   * Renders from configuration alone. Deliberately does no probing: this runs on every
   * config change and at activation, and a network call here would make the status bar a
   * polling loop.
   */
  private async showConfigured(): Promise<void> {
    const registry = this.factory.getRegistry();
    const store = this.factory.getStore();
    const descriptor = registry.get(this.factory.configuredProviderId);

    if (!descriptor) {
      this.showUnconfigured('No model provider selected');
      return;
    }

    if (!(await store.isConfigured(descriptor))) {
      this.showUnconfigured(`${descriptor.label} is not configured`);
      return;
    }

    const modelFieldId = descriptor.fields.find(
      (field) => field.kind === 'model' && field.role !== 'embedding',
    )?.id;
    const model = modelFieldId ? store.read(descriptor)[modelFieldId] : undefined;

    this.showActive(descriptor.label, model === undefined ? undefined : String(model));
  }

  private showActive(label: string, model?: string): void {
    this.item.text = `$(server-environment) ${shorten(model ?? label)}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**Repo Intelligence**\n\nProvider: ${label}\n\nModel: ${model ?? 'default'}\n\nClick to change.`,
    );
    this.item.backgroundColor = undefined;
  }

  private showFallback(payload: { providerLabel: string; model?: string; fallbackFrom?: string }): void {
    this.item.text = `$(warning) ${shorten(payload.model ?? payload.providerLabel)} (fallback)`;
    this.item.tooltip = new vscode.MarkdownString(
      `**Repo Intelligence — running on a fallback provider**\n\n` +
        `\`${payload.fallbackFrom}\` was unavailable, so this run is using ` +
        `**${payload.providerLabel}**${payload.model ? ` (${payload.model})` : ''}.\n\n` +
        `Click to change provider.`,
    );
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  private showUnconfigured(reason: string): void {
    this.item.text = '$(warning) Set up model provider';
    this.item.tooltip = `${reason}. Click to choose and configure one.`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose(): void {
    this.unsubscribes.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.item.dispose();
  }
}

/** Model ids are long; the status bar has little room and the tooltip carries the full name. */
function shorten(value: string, limit = 22): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
