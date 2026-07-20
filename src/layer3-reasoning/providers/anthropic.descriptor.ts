import { ANTHROPIC_SECRET_KEY } from './AnthropicProvider';
import { ProviderDescriptor } from './descriptor';
import { ANTHROPIC_MODELS } from './modelCapabilities';

/**
 * Anthropic (Claude).
 *
 * Note the lazy `require` in `create`: `registry.ts` imports every descriptor, so a
 * top-level `import` of the provider — which pulls in `@anthropic-ai/sdk` — would load the
 * SDK on activation even for a user running Ollama.
 */
export const anthropicDescriptor: ProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  description: 'Cloud models with native tool calling',
  detail: 'Best autonomy on multi-file tasks. Requires an API key.',
  icon: 'cloud',
  docsUrl: 'https://console.anthropic.com/settings/keys',

  capabilities: { chat: true, embeddings: false, nativeTools: true, local: false },
  fallbackRank: 100,

  fields: [
    {
      id: 'apiKey',
      kind: 'secret',
      label: 'API Key',
      required: true,
      // The pre-registry key, stated verbatim so keys already in the keychain keep working.
      secretKey: ANTHROPIC_SECRET_KEY,
      placeholder: 'sk-ant-...',
      description: 'Stored in the OS keychain via SecretStorage, never in settings.',
      pattern: '^sk-ant-',
      patternWarning: 'Anthropic keys normally begin with "sk-ant-".',
    },
    {
      id: 'model',
      kind: 'model',
      label: 'Model',
      required: true,
      role: 'chat',
      default: ANTHROPIC_MODELS.opus,
      legacySettingKey: 'anthropic.model',
      source: {
        type: 'fixed',
        options: [
          {
            value: ANTHROPIC_MODELS.opus,
            label: 'Claude Opus 4.8',
            description: 'Most capable',
            detail: 'Best for long, multi-file agent runs',
          },
          {
            value: ANTHROPIC_MODELS.sonnet,
            label: 'Claude Sonnet 5',
            description: 'Balanced',
            detail: 'Near-Opus quality on coding, lower cost',
          },
          {
            value: ANTHROPIC_MODELS.haiku,
            label: 'Claude Haiku 4.5',
            description: 'Fastest',
            detail: 'Simple, scoped edits',
          },
        ],
      },
    },
    {
      id: 'effort',
      kind: 'enum',
      label: 'Reasoning effort',
      required: false,
      default: 'high',
      legacySettingKey: 'anthropic.effort',
      description: 'Depth of reasoning and token spend. Ignored by Haiku 4.5.',
      options: [
        { value: 'low', label: 'Low', detail: 'Quick, scoped edits' },
        { value: 'medium', label: 'Medium', detail: 'Cost-sensitive work' },
        { value: 'high', label: 'High', detail: 'Default — good balance' },
        { value: 'xhigh', label: 'Extra high', detail: 'Hardest agentic coding' },
        { value: 'max', label: 'Max', detail: 'Correctness over cost' },
      ],
    },
  ],

  create(host) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AnthropicProvider } = require('./AnthropicProvider') as typeof import('./AnthropicProvider');
    return new AnthropicProvider(host.secrets, host.logger);
  },
};
