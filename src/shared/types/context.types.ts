// ═══════════════════════════════════════════════════════════════
// Context Engine Types — Retrieval, search, scoring
// ═══════════════════════════════════════════════════════════════

import { SymbolInfo } from './ast.types';
import { FrameworkInfo } from './scanner.types';

export type QueryType = 'chat' | 'generate' | 'review' | 'refactor' | 'explain';

export interface ContextQuery {
  type: QueryType;
  userMessage: string;
  activeFile?: string;
  activeFileContent?: string;
  selectedCode?: string;
  maxTokens: number;
  conversationHistory?: ChatMessage[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ContextFile {
  path: string;
  relativePath: string;
  content: string;
  relevanceScore: number;
  reason: string;
  category: string;
  tokenCount: number;
}

export interface ProjectConvention {
  category: string;
  rule: string;
  examples: string[];
  confidence: number;
}

export interface DependencyInfo {
  name: string;
  version: string;
  isDevDependency: boolean;
  category: string;
}

export interface RetrievedContext {
  files: ContextFile[];
  symbols: SymbolInfo[];
  framework: FrameworkInfo;
  conventions: ProjectConvention[];
  dependencies: DependencyInfo[];
  totalTokens: number;
  retrievalDuration: number;
}

export interface SearchResult {
  filePath: string;
  content: string;
  score: number;
  matchType: 'keyword' | 'semantic' | 'hybrid';
  highlights: string[];
}
