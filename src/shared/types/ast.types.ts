// ═══════════════════════════════════════════════════════════════
// AST Types — Symbols, imports, exports, patterns
// ═══════════════════════════════════════════════════════════════

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'hook'
  | 'component'
  | 'decorator'
  | 'method'
  | 'property';

export interface LocationRange {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
}

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  signature: string;
  documentation: string;
  location: LocationRange;
  complexity: number;
  dependencies: string[];
  isExported: boolean;
  isDefault: boolean;
  decorators: string[];
  metadata: Record<string, unknown>;
}

export interface ImportInfo {
  source: string;
  resolvedPath: string | null;
  specifiers: string[];
  isTypeOnly: boolean;
  isExternal: boolean;
  isDynamic: boolean;
}

export interface ExportInfo {
  name: string;
  kind: SymbolKind;
  isDefault: boolean;
  isReExport: boolean;
  source: string | null;
}

export type DetectedPatternType =
  | 'singleton'
  | 'factory'
  | 'observer'
  | 'strategy'
  | 'decorator-pattern'
  | 'hoc'
  | 'render-props'
  | 'compound-component'
  | 'custom-hook'
  | 'context-provider'
  | 'reducer'
  | 'middleware'
  | 'repository'
  | 'dependency-injection'
  | 'module-pattern'
  | 'barrel-export';

export interface DetectedPattern {
  type: DetectedPatternType;
  symbolName: string;
  confidence: number;
  evidence: string;
}

export interface ParsedFile {
  path: string;
  relativePath: string;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  patterns: DetectedPattern[];
  lineCount: number;
  complexity: number;
}

export interface FileCluster {
  name: string;
  files: string[];
  cohesion: number; // 0-1
  type: string;
}
