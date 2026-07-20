import { ProviderFactory } from '../../layer3-reasoning/providers/ProviderFactory';
import { ProviderSetupService } from '../../layer3-reasoning/providers/ProviderSetupService';
import { ModelCatalogService } from '../../layer3-reasoning/providers/ModelCatalogService';
import { toWireSchema } from '../../layer3-reasoning/providers/descriptor';
import {
  ListModelsParams,
  ProviderSummaryDto,
  RpcMethod,
  SaveParams,
  ValidateParams,
} from '../../shared/types/webview.types';

/**
 * Handles the correlated requests the settings panel makes.
 *
 * Every method resolves or rejects — never neither. `postMessage` is fire-and-forget, so a
 * handler that returns without replying leaves a pending entry and its timeout alive on the
 * webview side for the rest of the session.
 */
export class ProviderRpcHandler {
  constructor(
    private readonly factory: ProviderFactory,
    private readonly setup: ProviderSetupService = new ProviderSetupService(factory),
    private readonly catalog: ModelCatalogService = new ModelCatalogService(factory, setup),
  ) {}

  async handle(method: RpcMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'providers:list':
        return this.listProviders();
      case 'providers:listModels':
        return this.listModels(params as ListModelsParams);
      case 'providers:validate':
        return this.setup.validate((params as ValidateParams).providerId, (params as ValidateParams).draft);
      case 'providers:save':
        return this.save(params as SaveParams);
      default:
        throw new Error(`Unknown provider request: ${method}`);
    }
  }

  /**
   * Schema plus configured state for every provider.
   *
   * Deliberately returns no secret *values* — only whether one is stored. There is no
   * message anywhere in this protocol that sends a key back to the webview.
   */
  private async listProviders(): Promise<ProviderSummaryDto[]> {
    const registry = this.factory.getRegistry();
    const store = this.factory.getStore();
    const summaries: ProviderSummaryDto[] = [];

    for (const descriptor of registry.chatCapable()) {
      const storedSecrets: Record<string, boolean> = {};
      for (const field of this.setup.secretFieldsOf(descriptor)) {
        storedSecrets[field.id] = await this.setup.hasStoredSecret(field);
      }

      const raw = store.read(descriptor);
      const values: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value !== undefined) values[key] = value;
      }

      summaries.push({
        schema: toWireSchema(descriptor),
        configured: await store.isConfigured(descriptor),
        storedSecrets,
        values,
      });
    }

    return summaries;
  }

  private async listModels(params: ListModelsParams) {
    return this.setup.listModels(params.providerId, params.fieldId, params.draft);
  }

  private async save(params: SaveParams) {
    await this.setup.save(params.providerId, params.draft);
    // Newly-configured providers change what the dropdown should show.
    this.catalog.invalidate();
    return { ok: true };
  }

  getCatalog(): ModelCatalogService {
    return this.catalog;
  }

  getSetup(): ProviderSetupService {
    return this.setup;
  }
}
