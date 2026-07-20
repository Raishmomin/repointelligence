// ═══════════════════════════════════════════════════════════════
// Database Types — Records, queries, repository interfaces
// ═══════════════════════════════════════════════════════════════

export interface ProjectRecord {
  id: string;
  name: string;
  root_path: string;
  framework: string;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  last_scan: number | null;
}

export interface FileRecord {
  id: string;
  project_id: string;
  path: string;
  relative_path: string;
  language: string;
  category: string;
  content: string;
  content_hash: string;
  size: number;
  last_modified: number;
  last_indexed: number | null;
}

export interface SymbolRecord {
  id: string;
  file_id: string;
  name: string;
  kind: string;
  signature: string | null;
  documentation: string | null;
  start_line: number;
  end_line: number;
  start_col: number | null;
  end_col: number | null;
  complexity: number;
  metadata: string | null;
}

export interface DependencyRecord {
  id: string;
  source_file_id: string;
  target_file_id: string | null;
  source_symbol: string | null;
  target_symbol: string | null;
  dep_type: string;
  is_external: number;
  module_name: string | null;
}

export interface EmbeddingRecord {
  id: string;
  file_id: string | null;
  symbol_id: string | null;
  chunk_text: string;
  chunk_type: string;
  vector: Uint8Array;
  created_at: number;
}

export interface PatternRecord {
  id: string;
  project_id: string;
  pattern: string;
  file_id: string | null;
  symbol_name: string | null;
  confidence: number;
  metadata: string | null;
}

export interface ConventionRecord {
  id: string;
  project_id: string;
  category: string;
  rule: string;
  examples: string | null;
  confidence: number;
}

export interface ChatSessionRecord {
  id: string;
  project_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRecord {
  id: string;
  session_id: string;
  role: string;
  content: string;
  context_summary: string | null;
  model: string | null;
  tokens_used: number | null;
  created_at: number;
}
