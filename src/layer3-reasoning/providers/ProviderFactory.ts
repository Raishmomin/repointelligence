import * as vscode from 'vscode';
import { Logger } from '../../shared/Logger';
import { OllamaClient } from '../ollama/OllamaClient';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { LlmProvider, ProviderId } from './types';

/**
 * Resolves the configured chat provider, and — separately — the embedding provider.
 *
 * These are deliberately distinct: the Anthropic API has no embeddings endpoint, so
 * semantic search always runs through Ollama even when Claude is driving the agent.
 */
export class ProviderFactory implements vscode.Disposable {
  private anthropic: AnthropicProvider | undefined;
  private ollama: OllamaProvider | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly ollamaClient: OllamaClient,
    private readonly logger: Logger = Logger.getInstance(),
  ) {
    this.subscriptions.push(
      secrets.onDidChange((event) => {
        if (event.key.startsWith('repo-intelligence.')) this.anthropic?.invalidate();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('repo-intelligence.anthropic')) this.anthropic?.invalidate();
        if (event.affectsConfiguration('repo-intelligence.ollama')) this.ollamaClient.updateConfig();
      }),
    );
  }

  get configuredProviderId(): ProviderId {
    return vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<ProviderId>('provider', 'anthropic');
  }

  /** The provider the agent loop should use, per settings. */
  getChatProvider(): LlmProvider {
    return this.configuredProviderId === 'ollama' ? this.getOllama() : this.getAnthropic();
  }

  /**
   * Returns the configured provider if it is usable, otherwise falls back to the other one
   * and explains why. Returns undefined when neither is available.
   */
  async resolveChatProvider(): Promise<{ provider: LlmProvider; notice?: string } | undefined> {
    const preferred = this.getChatProvider();
    if (await preferred.isAvailable()) return { provider: preferred };

    const preferredReason = await preferred.unavailableReason();
    const alternate = preferred.id === 'anthropic' ? this.getOllama() : this.getAnthropic();

    if (await alternate.isAvailable()) {
      const notice = `${preferredReason} Falling back to ${alternate.id}.`;
      this.logger.warn(notice);
      return { provider: alternate, notice };
    }

    const alternateReason = await alternate.unavailableReason();
    this.logger.error(`No LLM provider available. ${preferredReason} ${alternateReason}`);
    return undefined;
  }

  /**
   * Embeddings only ever come from Ollama. Returns undefined when it is unreachable, in
   * which case retrieval degrades to keyword-only.
   */
  async getEmbeddingProvider(): Promise<OllamaClient | undefined> {
    const health = await this.ollamaClient.checkHealth();
    if (!health.available) {
      this.logger.info('Ollama unavailable; semantic search disabled, using keyword retrieval only.');
      return undefined;
    }
    return this.ollamaClient;
  }

  private getAnthropic(): AnthropicProvider {
    if (!this.anthropic) this.anthropic = new AnthropicProvider(this.secrets, this.logger);
    return this.anthropic;
  }

  private getOllama(): OllamaProvider {
    if (!this.ollama) this.ollama = new OllamaProvider(this.ollamaClient, this.logger);
    return this.ollama;
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}
