// ═══════════════════════════════════════════════════════════════
// File Utilities — Path normalization, extension detection, hashing
// ═══════════════════════════════════════════════════════════════

import * as path from 'path';
import * as crypto from 'crypto';
import { Language } from '../types';

const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mts': 'typescript',
  '.mjs': 'javascript',
  '.cts': 'typescript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

/**
 * Detect the language of a file based on its extension.
 */
export function detectLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

/**
 * Normalize a file path to use forward slashes (cross-platform).
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Get the relative path from a root directory, normalized.
 */
export function getRelativePath(rootPath: string, filePath: string): string {
  return normalizePath(path.relative(rootPath, filePath));
}

/**
 * Compute SHA-256 hash of file content.
 */
export function hashContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a file is a TypeScript/JavaScript source file.
 */
export function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'].includes(ext);
}

/**
 * Check if a file is a test file based on common naming conventions.
 */
export function isTestFile(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  return (
    normalized.includes('__tests__') ||
    normalized.includes('__test__') ||
    normalized.includes('.test.') ||
    normalized.includes('.spec.') ||
    normalized.includes('/test/') ||
    normalized.includes('/tests/')
  );
}

/**
 * Check if a file is a configuration file.
 */
export function isConfigFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  const configPatterns = [
    /^\..*rc(\..*)?$/,          // .eslintrc, .prettierrc, .babelrc
    /.*config\.(ts|js|mjs|json)$/,  // next.config.ts, vite.config.ts
    /^tsconfig.*\.json$/,       // tsconfig.json, tsconfig.build.json
    /^jest\..*$/,               // jest.config.ts
    /^vitest\..*$/,             // vitest.config.ts
    /^tailwind\..*$/,           // tailwind.config.ts
    /^postcss\..*$/,            // postcss.config.js
  ];
  return configPatterns.some(p => p.test(basename));
}
