import { anthropicDescriptor } from './anthropic.descriptor';
import { ProviderDescriptor } from './descriptor';
import { ollamaDescriptor } from './ollama.descriptor';

/**
 * Every provider the extension knows about.
 *
 * **This is the only file you edit to add one.** A new provider is its implementation file,
 * its descriptor, and one entry here — no factory change, no union type, no package.json
 * change, and no branching anywhere. The setup wizard, status bar, fallback chain and run
 * diagnostics all pick it up from the descriptor.
 */
export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  anthropicDescriptor,
  ollamaDescriptor,
];
