// ═══════════════════════════════════════════════════════════════
// GitIgnore Filter — Parse .gitignore and filter file paths
// ═══════════════════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_EXCLUDE_DIRS } from '../../shared/constants';

/**
 * Filters files based on .gitignore rules and built-in exclude patterns.
 * Uses a simplified but effective pattern matching approach — handles
 * the most common .gitignore patterns without a full glob engine.
 */
export class GitIgnoreFilter {
  private ignorePatterns: string[] = [];
  private excludeDirs: Set<string>;

  constructor(private rootPath: string, customExcludes: string[] = []) {
    this.excludeDirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...customExcludes]);
    this.loadGitIgnore();
  }

  /** Check if a path should be ignored. */
  shouldIgnore(filePath: string): boolean {
    const relativePath = path.relative(this.rootPath, filePath).replace(/\\/g, '/');
    const parts = relativePath.split('/');

    // Check directory-level excludes first (fast path)
    for (const part of parts) {
      if (this.excludeDirs.has(part)) return true;
    }

    // Check .gitignore patterns
    for (const pattern of this.ignorePatterns) {
      if (this.matchPattern(relativePath, pattern)) return true;
    }

    return false;
  }

  /** Check if a directory name should be skipped entirely (optimization). */
  shouldSkipDirectory(dirName: string): boolean {
    return this.excludeDirs.has(dirName) || dirName.startsWith('.');
  }

  private loadGitIgnore(): void {
    const gitignorePath = path.join(this.rootPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return;

    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      this.ignorePatterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .filter(line => !line.startsWith('!')); // Skip negation patterns for simplicity
    } catch {
      // Silently ignore read errors
    }
  }

  private matchPattern(filePath: string, pattern: string): boolean {
    // Remove trailing slash (directory indicator)
    const cleanPattern = pattern.replace(/\/$/, '');

    // Exact directory name match (e.g., "dist", "build")
    if (!cleanPattern.includes('/') && !cleanPattern.includes('*')) {
      const parts = filePath.split('/');
      return parts.some(part => part === cleanPattern);
    }

    // Simple wildcard matching
    if (cleanPattern.includes('*')) {
      const regex = new RegExp(
        '^' + cleanPattern
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.*')
          .replace(/(?<!\.)(\*)/g, '[^/]*') + '$',
      );
      return regex.test(filePath);
    }

    // Path prefix match
    return filePath.startsWith(cleanPattern) || filePath.includes('/' + cleanPattern);
  }
}
