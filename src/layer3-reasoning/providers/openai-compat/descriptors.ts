import { ProviderDescriptor } from '../descriptor';
import { VendorConfig, VENDORS } from './vendors';

/**
 * Builds a descriptor per OpenAI-compatible vendor.
 *
 * They differ only in the values already captured in `VendorConfig`, so the descriptors are
 * generated rather than hand-written five times. Adding a sixth vendor is a row in
 * `VENDORS` — this file does not change.
 */
function descriptorFor(vendor: VendorConfig): ProviderDescriptor {
  return {
    id: vendor.id,
    label: vendor.label,
    description: vendor.description,
    detail: vendor.detail,
    icon: vendor.icon,
    docsUrl: vendor.docsUrl,

    capabilities: {
      chat: true,
      // Deliberately false for all of them. These vendors do expose /embeddings, but the
      // index holds 768-dimension nomic-embed-text vectors and the rows carry no model
      // identity — enabling a second embedder would write incompatible-dimension vectors
      // into the same table with no error, silently degrading search. Versioning embedding
      // rows by model is a prerequisite, and a separate change.
      embeddings: false,
      nativeTools: true,
      local: false,
    },
    fallbackRank: vendor.fallbackRank,

    fields: [
      {
        id: 'apiKey',
        kind: 'secret',
        label: 'API Key',
        required: true,
        secretKey: vendor.secretKey,
        placeholder: vendor.keyPlaceholder,
        description: 'Stored in the OS keychain via SecretStorage, never in settings.',
        pattern: vendor.keyPattern,
        patternWarning: vendor.keyPatternWarning,
      },
      {
        id: 'baseUrl',
        kind: 'url',
        label: 'Base URL',
        required: false,
        default: vendor.defaultBaseUrl,
        description: 'Override only for a proxy or self-hosted gateway.',
      },
      {
        id: 'model',
        kind: 'model',
        label: 'Model',
        required: true,
        role: 'chat',
        default: vendor.defaultModel,
        source: {
          type: 'dynamic',
          allowCustom: true,
          emptyMessage: `Could not list ${vendor.label} models. Check the API key and base URL.`,
          async list(context) {
            // Constructed here rather than reusing a cached provider: this runs against the
            // in-progress draft, which may hold a key the user has not saved yet.
            const { OpenAICompatProvider } = await import('./OpenAICompatProvider');
            const { Logger } = await import('../../../shared/Logger');
            const probe = new OpenAICompatProvider(vendor, context, Logger.getInstance());
            const models = await probe.listModels();
            return models.map((model) => ({
              value: model.id,
              label: model.label,
              description: model.id === model.label ? undefined : model.id,
              detail: model.detail,
            }));
          },
        },
      },
      {
        id: 'contextWindow',
        kind: 'number',
        label: 'Context window',
        required: false,
        default: vendor.contextWindow,
        description: 'Used to decide when to compact the agent transcript.',
      },
    ],

    create(host) {
      // Lazy: registry.ts imports every descriptor, so a top-level import would pull this
      // module into activation for users who never touch these providers.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OpenAICompatProvider } = require('./OpenAICompatProvider') as typeof import('./OpenAICompatProvider');
      return OpenAICompatProvider.create(vendor, host);
    },
  };
}

export const OPENAI_COMPAT_DESCRIPTORS: ProviderDescriptor[] = VENDORS.map(descriptorFor);
