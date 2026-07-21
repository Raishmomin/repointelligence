// ═══════════════════════════════════════════════════════════════
// Service Container — Lazy DI / Service Locator
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { Logger } from './shared/Logger';
import { EventBus } from './shared/EventBus';
import { DatabaseManager } from './layer2-context/database/DatabaseManager';
import { FileRepository } from './layer2-context/database/repositories/FileRepository';
import { SymbolRepository } from './layer2-context/database/repositories/SymbolRepository';
import { DependencyRepository } from './layer2-context/database/repositories/DependencyRepository';
import { EmbeddingRepository } from './layer2-context/database/repositories/EmbeddingRepository';
import { ChatRepository } from './layer2-context/database/repositories/ChatRepository';
import { RepositoryScanner } from './layer1-intelligence/scanner/RepositoryScanner';
import { FrameworkDetector } from './layer1-intelligence/framework/FrameworkDetector';
import { PackageDetector } from './layer1-intelligence/packages/PackageDetector';
import { ASTParser } from './layer1-intelligence/ast/ASTParser';
import { DependencyGraph } from './layer1-intelligence/graph/DependencyGraph';
import { OllamaClient } from './layer3-reasoning/ollama/OllamaClient';
import { ProviderFactory } from './layer3-reasoning/providers/ProviderFactory';
import { HybridSearchEngine } from './layer2-context/search/HybridSearchEngine';
import { ContextAssembler } from './layer2-context/context/ContextAssembler';
import { PromptBuilder } from './layer2-context/prompt/PromptBuilder';
import { ChatWebviewProvider } from './vscode/providers/ChatWebviewProvider';
import { AgentService } from './layer3-reasoning/agent/AgentService';
import { ChangeSetService } from './layer3-reasoning/agent/ChangeSetService';
import { CommandRunner } from './layer3-reasoning/agent/CommandRunner';
import { DEFAULTS } from './shared/constants';

/**
 * Central service container for dependency management.
 * Lazily creates and caches service instances.
 * All services are scoped to the extension's lifetime.
 */
export class ServiceContainer {
  private static instance: ServiceContainer;
  private services = new Map<string, any>();
  private context: vscode.ExtensionContext;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  static initialize(context: vscode.ExtensionContext): ServiceContainer {
    ServiceContainer.instance = new ServiceContainer(context);
    return ServiceContainer.instance;
  }

  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return ServiceContainer.instance;
  }

  get extensionContext(): vscode.ExtensionContext {
    return this.context;
  }

  // ── Core Services ──────────────────────────────────────────

  get logger(): Logger {
    return Logger.getInstance();
  }

  get eventBus(): EventBus {
    return EventBus.getInstance();
  }

  // ── Database ───────────────────────────────────────────────

  get database(): DatabaseManager {
    return this.getOrCreate('database', () => {
      const storagePath = this.context.globalStorageUri.fsPath;
      return new DatabaseManager(storagePath);
    });
  }

  get fileRepository(): FileRepository {
    return this.getOrCreate('fileRepository', () => new FileRepository(this.database));
  }

  get symbolRepository(): SymbolRepository {
    return this.getOrCreate('symbolRepository', () => new SymbolRepository(this.database));
  }

  get dependencyRepository(): DependencyRepository {
    return this.getOrCreate('dependencyRepository', () => new DependencyRepository(this.database));
  }

  get chatRepository(): ChatRepository {
    return this.getOrCreate('chatRepository', () => new ChatRepository(this.database));
  }

  get embeddingRepository(): EmbeddingRepository {
    return this.getOrCreate('embeddingRepository', () => new EmbeddingRepository(this.database));
  }

  // ── Layer 1 ────────────────────────────────────────────────

  get scanner(): RepositoryScanner {
    return this.getOrCreate('scanner', () => {
      const config = vscode.workspace.getConfiguration('repo-intelligence');
      const maxFileSize = config.get<number>('scan.maxFileSize', DEFAULTS.MAX_FILE_SIZE);
      return new RepositoryScanner(maxFileSize);
    });
  }

  get frameworkDetector(): FrameworkDetector {
    return this.getOrCreate('frameworkDetector', () => new FrameworkDetector());
  }

  get packageDetector(): PackageDetector {
    return this.getOrCreate('packageDetector', () => new PackageDetector());
  }

  get astParser(): ASTParser {
    return this.getOrCreate('astParser', () => new ASTParser());
  }

  get dependencyGraph(): DependencyGraph {
    return this.getOrCreate('dependencyGraph', () => new DependencyGraph());
  }

  get ollamaClient(): OllamaClient {
    return this.getOrCreate('ollamaClient', () => new OllamaClient());
  }

  get providerFactory(): ProviderFactory {
    return this.getOrCreate(
      'providerFactory',
      () => new ProviderFactory(this.context.secrets, this.ollamaClient),
    );
  }

  get hybridSearchEngine(): HybridSearchEngine {
    return this.getOrCreate('hybridSearchEngine', () => new HybridSearchEngine(this.database, this.ollamaClient));
  }

  get contextAssembler(): ContextAssembler {
    return this.getOrCreate('contextAssembler', () => new ContextAssembler(this.hybridSearchEngine));
  }

  get promptBuilder(): PromptBuilder {
    return this.getOrCreate('promptBuilder', () => new PromptBuilder());
  }

  get chatWebviewProvider(): ChatWebviewProvider {
    return this.getOrCreate('chatWebviewProvider', () => new ChatWebviewProvider());
  }
  get changeSetService(): ChangeSetService { return this.getOrCreate('changeSetService', () => new ChangeSetService(this)); }
  get commandRunner(): CommandRunner { return this.getOrCreate('commandRunner', () => new CommandRunner(this)); }
  get agentService(): AgentService { return this.getOrCreate('agentService', () => new AgentService(this)); }

  // ── Helpers ────────────────────────────────────────────────

  private getOrCreate<T>(key: string, factory: () => T): T {
    if (!this.services.has(key)) {
      this.services.set(key, factory());
    }
    return this.services.get(key) as T;
  }

  async dispose(): Promise<void> {
    if (this.services.has('astParser')) {
      this.astParser.dispose();
    }
    if (this.services.has('providerFactory')) {
      this.providerFactory.dispose();
    }
    this.database.close();
    this.logger.dispose();
    this.eventBus.removeAllListeners();
    this.services.clear();
  }
}
