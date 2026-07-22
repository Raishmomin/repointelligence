import { ProviderDescriptor, ProviderOption } from './descriptor';
import { assessModel, rankModels } from './ollamaModels';

const DEFAULT_URL = 'http://127.0.0.1:11434';
const RECOMMENDED_MODEL = 'qwen2.5-coder:7b';

interface OllamaTag {
  name: string;
  details?: { parameter_size?: string };
}

/**
 * Lists models the user has actually pulled.
 *
 * Fetches directly rather than going through `OllamaClient` so it honours the base URL in
 * the *draft* — the user may have just typed a new host that has not been saved. Listing
 * tags is a fast call, so the client's long-inference timeout shim is not needed here.
 */
async function listInstalledModels(baseUrl: string): Promise<ProviderOption[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Ollama responded ${response.status}`);

  const body = (await response.json()) as { models?: OllamaTag[] };
  const tags = body.models ?? [];

  // Ranked so a model that can actually drive the agent is the obvious first choice, and
  // one that cannot is visibly marked rather than silently offered.
  return rankModels(
    tags.map((tag) => ({ name: tag.name, parameterSize: tag.details?.parameter_size })),
  ).map((model) => {
    const assessment = assessModel(model.name, model.parameterSize);
    return {
      value: model.name,
      // Plain name: the old `$(warning)` codicon suffix rendered as literal text in the
      // React picker. The caution flag carries the warning instead, styled per surface.
      label: model.name,
      caution: assessment.fitness !== 'good',
      description: model.parameterSize,
      detail:
        assessment.fitness === 'good'
          ? 'Handles tool calling well'
          : assessment.fitness === 'marginal'
            ? 'May struggle with multi-step tool use'
            : 'Too small for tool calling — will ask you where files are',
    };
  });
}

export const ollamaDescriptor: ProviderDescriptor = {
  id: 'ollama',
  label: 'Ollama (local)',
  description: 'Runs entirely on your machine',
  detail: 'Free and offline. Needs a 7B+ coder model to use tools reliably.',
  icon: 'device-desktop',
  docsUrl: 'https://ollama.com/library',

  capabilities: { chat: true, embeddings: true, nativeTools: false, local: true },
  // Ranked last on purpose: a local model quietly taking over a Claude run is exactly what
  // the run diagnostics exist to surface, so it should be the last resort, not the first.
  fallbackRank: 10,

  fields: [
    {
      id: 'baseUrl',
      kind: 'url',
      label: 'Server URL',
      required: true,
      default: DEFAULT_URL,
      legacySettingKey: 'ollama.url',
      placeholder: DEFAULT_URL,
    },
    {
      id: 'model',
      kind: 'model',
      label: 'Model',
      required: true,
      role: 'chat',
      default: RECOMMENDED_MODEL,
      legacySettingKey: 'ollama.chatModel',
      description: 'Needs to be capable enough to emit structured tool calls.',
      source: {
        type: 'dynamic',
        allowCustom: true,
        emptyMessage:
          `No models found. Pull one first, for example:  ollama pull ${RECOMMENDED_MODEL}`,
        list: (context) => listInstalledModels(context.getString('baseUrl', DEFAULT_URL)),
      },
    },
    {
      id: 'embeddingModel',
      kind: 'string',
      label: 'Embedding model',
      required: false,
      default: 'nomic-embed-text',
      legacySettingKey: 'ollama.embeddingModel',
      description: 'Used for semantic search. Needs a separate pull.',
    },
    {
      id: 'contextWindow',
      kind: 'number',
      label: 'Context window',
      required: false,
      default: 32_000,
      legacySettingKey: 'ollama.contextWindow',
      description: 'Used to decide when to compact the agent transcript.',
    },
  ],

  create(host) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OllamaProvider } = require('./OllamaProvider') as typeof import('./OllamaProvider');
    return new OllamaProvider(host.services.ollamaClient, host.logger);
  },

  createEmbedder(host) {
    const client = host.services.ollamaClient;
    return {
      id: 'ollama',
      isAvailable: async () => (await client.checkHealth()).available,
      embed: async (texts) => {
        const vectors: Float32Array[] = [];
        for (const text of texts) {
          vectors.push(Float32Array.from(await client.getEmbedding(text)));
        }
        return vectors;
      },
    };
  },
};
