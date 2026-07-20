// ═══════════════════════════════════════════════════════════════
// Constants — Extension-wide configuration and defaults
// ═══════════════════════════════════════════════════════════════

export const EXTENSION_ID = 'repo-intelligence';
export const EXTENSION_NAME = 'Repository Intelligence Engine';

// ── Commands ──────────────────────────────────────────────────
export const COMMANDS = {
  SCAN_REPOSITORY: `${EXTENSION_ID}.scanRepository`,
  OPEN_CHAT: `${EXTENSION_ID}.openChat`,
  GENERATE_CODE: `${EXTENSION_ID}.generateCode`,
  REVIEW_CODE: `${EXTENSION_ID}.reviewCode`,
  SHOW_KNOWLEDGE: `${EXTENSION_ID}.showKnowledge`,
  START_AGENT: `${EXTENSION_ID}.startAgent`,
  REVIEW_CHANGE_SET: `${EXTENSION_ID}.reviewChangeSet`,
  APPROVE_CHANGE_SET: `${EXTENSION_ID}.approveChangeSet`,
  REJECT_CHANGE_SET: `${EXTENSION_ID}.rejectChangeSet`,
  APPROVE_COMMAND: `${EXTENSION_ID}.approveCommand`,
  REJECT_COMMAND: `${EXTENSION_ID}.rejectCommand`,
  REVERT_CHANGE_SET: `${EXTENSION_ID}.revertChangeSet`,
  SHOW_AGENT_HISTORY: `${EXTENSION_ID}.showAgentHistory`,
  REVOKE_SESSION_TRUST: `${EXTENSION_ID}.revokeSessionTrust`,
  SET_API_KEY: `${EXTENSION_ID}.setApiKey`,
  CLEAR_API_KEY: `${EXTENSION_ID}.clearApiKey`,
  CANCEL_AGENT: `${EXTENSION_ID}.cancelAgent`,
  CHOOSE_MODEL_PROVIDER: `${EXTENSION_ID}.chooseModelProvider`,
} as const;

// ── Views ─────────────────────────────────────────────────────
export const VIEWS = {
  CHAT: `${EXTENSION_ID}.chatView`,
  KNOWLEDGE: `${EXTENSION_ID}.knowledgeView`,
} as const;

// ── Configuration Keys ────────────────────────────────────────
export const CONFIG = {
  OLLAMA_URL: `${EXTENSION_ID}.ollama.url`,
  OLLAMA_CHAT_MODEL: `${EXTENSION_ID}.ollama.chatModel`,
  OLLAMA_EMBEDDING_MODEL: `${EXTENSION_ID}.ollama.embeddingModel`,
  SCAN_EXCLUDE_PATTERNS: `${EXTENSION_ID}.scan.excludePatterns`,
  SCAN_MAX_FILE_SIZE: `${EXTENSION_ID}.scan.maxFileSize`,
  CONTEXT_MAX_TOKENS: `${EXTENSION_ID}.context.maxTokens`,
  SCAN_AUTO_ON_OPEN: `${EXTENSION_ID}.scan.autoScanOnOpen`,
} as const;

// ── Defaults ──────────────────────────────────────────────────
export const DEFAULTS = {
  OLLAMA_URL: 'http://127.0.0.1:11434',
  CHAT_MODEL: 'deepseek-coder-v2:16b',
  EMBEDDING_MODEL: 'nomic-embed-text',
  MAX_FILE_SIZE: 524288, // 512KB
  MAX_TOKENS: 4096,
  EMBEDDING_BATCH_SIZE: 32,
  FILE_WATCHER_DEBOUNCE_MS: 500,
  SCAN_PROGRESS_INTERVAL_MS: 100,
} as const;

// ── File Extensions ───────────────────────────────────────────
export const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.mts', '.mjs', '.cts', '.cjs',
  '.json', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.md', '.mdx',
  '.yaml', '.yml',
]);

// ── Default Exclude Patterns ──────────────────────────────────
export const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
  '__pycache__',
  '.DS_Store',
  '.vscode',
  '.idea',
]);

// ── Database ──────────────────────────────────────────────────
export const DB_FILENAME = 'repo-intelligence.db';
export const DB_VERSION = 3;
