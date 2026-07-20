// ═══════════════════════════════════════════════════════════════
// AST Parser — ts-morph project analysis engine
// ═══════════════════════════════════════════════════════════════

import * as path from 'path';
import * as fs from 'fs';
import { Project, SourceFile, ts } from 'ts-morph';
import { Logger } from '../../shared/Logger';
import { EventBus } from '../../shared/EventBus';
import { ParsedFile } from '../../shared/types/ast.types';
import { SymbolExtractor } from './SymbolExtractor';
import { ImportResolver } from './ImportResolver';
import { PatternDetector } from './PatternDetector';

/**
 * Deep code analysis engine powered by ts-morph.
 *
 * Creates a lightweight ts-morph Project that resolves types,
 * symbols, and imports across the entire codebase. Files are
 * added selectively (not from tsconfig) to avoid parsing node_modules.
 */
export class ASTParser {
  private project: Project | null = null;
  private symbolExtractor = new SymbolExtractor();
  private importResolver = new ImportResolver();
  private patternDetector = new PatternDetector();
  private logger = Logger.getInstance();
  private eventBus = EventBus.getInstance();

  /**
   * Initialize the ts-morph Project for a workspace.
   * Uses the project's tsconfig if available, otherwise creates
   * a default compiler configuration.
   */
  initialize(rootPath: string): void {
    const tsConfigPath = this.findTsConfig(rootPath);

    if (tsConfigPath) {
      this.project = new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: true, // We add files manually for control
        skipFileDependencyResolution: false,
      });
      this.logger.info('AST Parser initialized with tsconfig', { tsConfigPath });
    } else {
      this.project = new Project({
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
          allowJs: true,
          strict: false, // Don't enforce strict on analyzed projects
          skipLibCheck: true,
          noEmit: true,
        },
      });
      this.logger.info('AST Parser initialized with default config (no tsconfig found)');
    }
  }

  /**
   * Add source files to the project for analysis.
   * Only adds files that haven't been added yet.
   */
  addFiles(filePaths: string[]): number {
    if (!this.project) throw new Error('ASTParser not initialized');

    let added = 0;
    for (const filePath of filePaths) {
      try {
        const existing = this.project.getSourceFile(filePath);
        if (!existing) {
          this.project.addSourceFileAtPath(filePath);
          added++;
        }
      } catch {
        // Skip files that can't be added (e.g., syntax errors)
      }
    }
    return added;
  }

  /**
   * Parse a single file and extract all intelligence.
   */
  parseFile(filePath: string): ParsedFile | null {
    if (!this.project) throw new Error('ASTParser not initialized');

    try {
      let sourceFile = this.project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = this.project.addSourceFileAtPath(filePath);
      }

      return this.extractFileIntelligence(sourceFile);
    } catch (error) {
      this.logger.warn('Failed to parse file', {
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Parse all added files and return structured results.
   * Emits progress events for the UI.
   */
  parseAll(rootPath: string): ParsedFile[] {
    if (!this.project) throw new Error('ASTParser not initialized');

    const sourceFiles = this.project.getSourceFiles();
    const results: ParsedFile[] = [];
    const total = sourceFiles.length;

    this.logger.info('Starting AST analysis', { files: total });

    for (let i = 0; i < sourceFiles.length; i++) {
      try {
        const parsed = this.extractFileIntelligence(sourceFiles[i]);
        if (parsed) results.push(parsed);
      } catch {
        // Skip problematic files
      }

      if (i % 50 === 0) {
        this.eventBus.emit('scan:progress', {
          phase: 'ast-analysis',
          current: i,
          total,
          message: `Analyzing code: ${i}/${total} files`,
        });
      }
    }

    this.logger.info('AST analysis complete', {
      parsed: results.length,
      symbols: results.reduce((sum, f) => sum + f.symbols.length, 0),
    });

    return results;
  }

  /**
   * Refresh a single file (after edit).
   * Removes old version and re-adds from disk.
   */
  refreshFile(filePath: string): ParsedFile | null {
    if (!this.project) return null;

    const existing = this.project.getSourceFile(filePath);
    if (existing) {
      this.project.removeSourceFile(existing);
    }

    if (fs.existsSync(filePath)) {
      return this.parseFile(filePath);
    }
    return null;
  }

  /**
   * Remove a file from the project (after deletion).
   */
  removeFile(filePath: string): void {
    if (!this.project) return;
    const sourceFile = this.project.getSourceFile(filePath);
    if (sourceFile) {
      this.project.removeSourceFile(sourceFile);
    }
  }

  /**
   * Core extraction: symbols, imports, exports, patterns from a SourceFile.
   */
  private extractFileIntelligence(sourceFile: SourceFile): ParsedFile {
    const filePath = sourceFile.getFilePath();
    const rootDir = this.project!.getCompilerOptions().rootDir || '';

    const symbols = this.symbolExtractor.extract(sourceFile);
    const imports = this.importResolver.resolve(sourceFile);
    const exports = this.symbolExtractor.extractExports(sourceFile);
    const patterns = this.patternDetector.detect(sourceFile, symbols);

    // Calculate file-level complexity
    const complexity = symbols.reduce((sum, s) => sum + s.complexity, 0);

    return {
      path: filePath,
      relativePath: path.relative(rootDir, filePath).replace(/\\/g, '/'),
      symbols,
      imports,
      exports,
      patterns,
      lineCount: sourceFile.getEndLineNumber(),
      complexity,
    };
  }

  /**
   * Find tsconfig.json in the project root or common locations.
   */
  private findTsConfig(rootPath: string): string | null {
    const candidates = [
      path.join(rootPath, 'tsconfig.json'),
      path.join(rootPath, 'tsconfig.app.json'),
      path.join(rootPath, 'tsconfig.build.json'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  dispose(): void {
    this.project = null;
  }
}
