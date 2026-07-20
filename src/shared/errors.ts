// ═══════════════════════════════════════════════════════════════
// Custom Errors — Typed error hierarchy for the extension
// ═══════════════════════════════════════════════════════════════

/**
 * Base error class for all Repository Intelligence errors.
 * Provides structured error context for logging and UI display.
 */
export class RepoIntelligenceError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'RepoIntelligenceError';
    this.code = code;
    this.context = context;
  }
}

export class ScanError extends RepoIntelligenceError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'SCAN_ERROR', context);
    this.name = 'ScanError';
  }
}

export class DatabaseError extends RepoIntelligenceError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DATABASE_ERROR', context);
    this.name = 'DatabaseError';
  }
}

export class ASTParseError extends RepoIntelligenceError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'AST_PARSE_ERROR', context);
    this.name = 'ASTParseError';
  }
}

export class OllamaError extends RepoIntelligenceError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'OLLAMA_ERROR', context);
    this.name = 'OllamaError';
  }
}

export class ContextRetrievalError extends RepoIntelligenceError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONTEXT_RETRIEVAL_ERROR', context);
    this.name = 'ContextRetrievalError';
  }
}

export class PromptBuildError extends RepoIntelligenceError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PROMPT_BUILD_ERROR', context);
    this.name = 'PromptBuildError';
  }
}
