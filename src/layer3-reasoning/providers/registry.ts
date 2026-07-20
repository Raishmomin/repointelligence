import { anthropicDescriptor } from './anthropic.descriptor';
import { ProviderDescriptor } from './descriptor';
import { ollamaDescriptor } from './ollama.descriptor';
import { OPENAI_COMPAT_DESCRIPTORS } from './openai-compat/descriptors';

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
  // OpenAI, Gemini, OpenRouter, Groq and Nvidia NIM — one entry each, generated from the
  // vendor table since they share the OpenAI-compatible dialect.
  ...OPENAI_COMPAT_DESCRIPTORS,
];
