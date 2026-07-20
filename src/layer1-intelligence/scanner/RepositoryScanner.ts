// ═══════════════════════════════════════════════════════════════
// Repository Scanner — Walk, classify, hash all project files
// ═══════════════════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { v4 as uuid } from 'uuid';
import { GitIgnoreFilter } from './GitIgnoreFilter';
import { FileClassifier } from './FileClassifier';
import { Logger } from '../../shared/Logger';
import { EventBus } from '../../shared/EventBus';
import { ScanError } from '../../shared/errors';
import { SUPPORTED_EXTENSIONS, DEFAULTS } from '../../shared/constants';
import { ScannedFile, ScanResult, ScanStats, FrameworkInfo, PackageInfo, Language } from '../../shared/types/scanner.types';
import { detectLanguage, normalizePath, getRelativePath, hashContent } from '../../shared/utils/fileUtils';

export class RepositoryScanner {
  private logger = Logger.getInstance();
  private eventBus = EventBus.getInstance();
  private classifier = new FileClassifier();
  private maxFileSize: number;

  constructor(maxFileSize: number = DEFAULTS.MAX_FILE_SIZE) {
    this.maxFileSize = maxFileSize;
  }

  /**
   * Full repository scan — walks the file tree, classifies files,
   * computes content hashes, and returns structured results.
   */
  async scan(
    rootPath: string,
    excludePatterns: string[],
    token?: vscode.CancellationToken,
  ): Promise<ScanResult> {
    const startTime = Date.now();
    const projectId = uuid();

    this.logger.info('Starting repository scan', { rootPath });
    this.eventBus.emit('scan:started', { rootPath });

    try {
      // Phase 1: Walk file tree
      const filter = new GitIgnoreFilter(rootPath, excludePatterns);
      const filePaths = this.walkDirectory(rootPath, filter, token);

      this.eventBus.emit('scan:progress', {
        phase: 'discovery', current: filePaths.length, total: filePaths.length,
        message: `Discovered ${filePaths.length} files`,
      });

      // Phase 2: Classify and hash files
      const files: ScannedFile[] = [];
      let skippedFiles = 0;

      for (let i = 0; i < filePaths.length; i++) {
        if (token?.isCancellationRequested) {
          throw new ScanError('Scan cancelled by user');
        }

        const filePath = filePaths[i];
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > this.maxFileSize) {
            skippedFiles++;
            continue;
          }

          const content = fs.readFileSync(filePath, 'utf-8');
          const relativePath = getRelativePath(rootPath, filePath);

          files.push({
            path: normalizePath(filePath),
            relativePath: normalizePath(relativePath),
            language: detectLanguage(filePath),
            category: this.classifier.classify(relativePath),
            content,
            hash: hashContent(content),
            size: stat.size,
            lastModified: stat.mtimeMs,
          });
        } catch {
          skippedFiles++;
        }

        // Progress update every 100 files
        if (i % 100 === 0) {
          this.eventBus.emit('scan:progress', {
            phase: 'classification', current: i, total: filePaths.length,
            message: `Classifying files: ${i}/${filePaths.length}`,
          });
        }
      }

      // Phase 3: Detect framework and packages
      const packages = this.readPackageJson(rootPath);
      // Framework detection is handled by FrameworkDetector (separate module)
      // For now, create a placeholder that will be enriched by FrameworkDetector
      const framework: FrameworkInfo = {
        primary: 'unknown', secondary: [], version: '',
        router: 'unknown', stateManagement: [], styling: [],
        testing: [], orm: null,
      };

      // Build stats
      const stats = this.buildStats(files, skippedFiles);
      const duration = Date.now() - startTime;

      const result: ScanResult = {
        projectId, rootPath, files, framework, packages, stats, duration,
      };

      this.logger.info('Repository scan complete', {
        files: files.length, skipped: skippedFiles, duration: `${duration}ms`,
      });

      return result;
    } catch (error) {
      const scanError = error instanceof ScanError ? error :
        new ScanError('Repository scan failed', {
          rootPath, error: error instanceof Error ? error.message : String(error),
        });
      this.eventBus.emit('scan:error', { error: scanError, rootPath });
      throw scanError;
    }
  }

  /**
   * Recursively walk a directory, applying gitignore filter.
   */
  private walkDirectory(
    dirPath: string,
    filter: GitIgnoreFilter,
    token?: vscode.CancellationToken,
  ): string[] {
    const results: string[] = [];
    const stack: string[] = [dirPath];

    while (stack.length > 0) {
      if (token?.isCancellationRequested) break;

      const currentDir = stack.pop()!;
      let entries: fs.Dirent[];

      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (!filter.shouldSkipDirectory(entry.name)) {
            stack.push(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext) && !filter.shouldIgnore(fullPath)) {
            results.push(fullPath);
          }
        }
      }
    }

    return results;
  }

  /**
   * Read and parse the root package.json.
   */
  public readPackageJson(rootPath: string): PackageInfo {
    const pkgPath = path.join(rootPath, 'package.json');
    const defaults: PackageInfo = {
      name: path.basename(rootPath), version: '0.0.0',
      dependencies: {}, devDependencies: {}, scripts: {},
      hasWorkspaces: false, workspaces: [],
    };

    if (!fs.existsSync(pkgPath)) return defaults;

    try {
      const content = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const workspaces = content.workspaces
        ? (Array.isArray(content.workspaces) ? content.workspaces : content.workspaces.packages ?? [])
        : [];

      return {
        name: content.name ?? defaults.name,
        version: content.version ?? defaults.version,
        dependencies: content.dependencies ?? {},
        devDependencies: content.devDependencies ?? {},
        scripts: content.scripts ?? {},
        hasWorkspaces: workspaces.length > 0,
        workspaces,
      };
    } catch {
      return defaults;
    }
  }

  private buildStats(files: ScannedFile[], skippedFiles: number): ScanStats {
    const byLanguage: Record<Language, number> = {} as Record<Language, number>;
    const byCategory: Record<string, number> = {};
    let totalSize = 0;

    for (const file of files) {
      byLanguage[file.language] = (byLanguage[file.language] || 0) + 1;
      byCategory[file.category] = (byCategory[file.category] || 0) + 1;
      totalSize += file.size;
    }

    return { totalFiles: files.length, byLanguage, byCategory, totalSize, skippedFiles };
  }
}
