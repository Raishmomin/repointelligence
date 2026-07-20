// ═══════════════════════════════════════════════════════════════
// Prompt Types — Builder, templates, optimization
// ═══════════════════════════════════════════════════════════════

import { ChatMessage } from './context.types';

export interface BuiltPrompt {
  system: string;
  messages: ChatMessage[];
  estimatedTokens: number;
  contextSummary: string;
  metadata: PromptMetadata;
}

export interface PromptMetadata {
  template: string;
  filesIncluded: number;
  symbolsIncluded: number;
  conventionsIncluded: number;
  truncated: boolean;
  originalTokens: number;
  optimizedTokens: number;
}

export type PromptTemplate =
  | 'code-generation'
  | 'code-review'
  | 'chat'
  | 'refactor'
  | 'explain'
  | 'architecture';
