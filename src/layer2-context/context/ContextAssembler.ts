// ═══════════════════════════════════════════════════════════════
// Context Assembler — Formulates and budgets retrieval contexts
// ═══════════════════════════════════════════════════════════════

import { ServiceContainer } from '../../container';
import { HybridSearchEngine } from '../search/HybridSearchEngine';
import { RetrievedContext, ContextQuery, ContextFile, ProjectConvention, DependencyInfo } from '../../shared/types/context.types';
import { estimateTokens } from '../../shared/utils/tokenCounter';
import { Logger } from '../../shared/Logger';
import * as path from 'path';

export class ContextAssembler {
  private logger = Logger.getInstance();

  constructor(
    private searchEngine: HybridSearchEngine
  ) {}

  /**
   * Assemble optimized codebase context for a user prompt, budget-limiting tokens dynamically.
   */
  async assemble(projectId: string, query: ContextQuery): Promise<RetrievedContext> {
    const container = ServiceContainer.getInstance();
    const startTime = Date.now();

    // 1. Fetch project info, frameworks, conventions
    const project = container.database.queryOne<{ framework: string; metadata: string }>(
      'SELECT framework, metadata FROM projects WHERE id = ?',
      [projectId]
    );

    const frameworkInfo = project ? JSON.parse(project.metadata) : {
      primary: 'unknown', secondary: [], version: '', router: 'unknown',
      stateManagement: [], styling: [], testing: [], orm: null,
    };

    const dbConventions = container.database.query<{ category: string; rule: string; examples: string; confidence: number }>(
      'SELECT category, rule, examples, confidence FROM conventions WHERE project_id = ?',
      [projectId]
    );

    const conventions: ProjectConvention[] = dbConventions.map(c => ({
      category: c.category,
      rule: c.rule,
      examples: JSON.parse(c.examples),
      confidence: c.confidence,
    }));

    // Retrieve active framework dependencies
    const packageInfo = container.scanner.readPackageJson(
      vscodeWorkspacePath()
    );
    const dependencies: DependencyInfo[] = container.packageDetector.getKeyDependencies(packageInfo);

    let searchResults = await this.searchEngine.search(projectId, query.userMessage, 15);
    // The current editor is always meaningful context, even when keyword retrieval
    // finds no overlap with the user's phrasing.
    const activeFile = query.activeFile;
    if (activeFile && !searchResults.some(result => path.normalize(result.filePath) === path.normalize(activeFile))) {
      try {
        const content = query.activeFileContent ?? require('fs').readFileSync(activeFile, 'utf8');
        searchResults.unshift({ filePath: activeFile, content, score: 1, matchType: 'keyword', highlights: [] });
      } catch { /* editor may be untitled or deleted */ }
    }
    
    if (searchResults.length === 0) {
      const fallbackFiles = container.database.query<{ id: string; path: string; category: string }>(
        'SELECT id, path, category FROM files WHERE project_id = ? ORDER BY size DESC LIMIT 8',
        [projectId]
      );
      for (const file of fallbackFiles) {
        try {
          if (require('fs').existsSync(file.path)) {
            const content = require('fs').readFileSync(file.path, 'utf-8');
            searchResults.push({
              filePath: file.path,
              content,
              score: 0.1,
              matchType: 'keyword',
              highlights: []
            });
          }
        } catch {
          // ignore
        }
      }
    }
    
    const contextFiles: ContextFile[] = [];
    let currentTokens = 0;
    
    // Reserve token budgets for framework description and conventions (~800 tokens)
    const reservedTokens = 800;
    const maxFileTokens = query.maxTokens - reservedTokens;

    for (const res of searchResults) {
      const fileTokens = estimateTokens(res.content);

      // If active file matches search file, prioritize it and bump score
      let score = res.score;
      let reason = `Relevance match (${res.matchType})`;

      if (query.activeFile && path.normalize(query.activeFile) === path.normalize(res.filePath)) {
        score = 1.0;
        reason = 'Active workspace editor file';
      }

      if (currentTokens + fileTokens <= maxFileTokens) {
        contextFiles.push({
          path: res.filePath,
          relativePath: path.relative(vscodeWorkspacePath(), res.filePath).replace(/\\/g, '/'),
          content: res.content,
          relevanceScore: score,
          reason,
          category: 'code',
          tokenCount: fileTokens,
        });
        currentTokens += fileTokens;
      } else {
        // Budget full, try to fit a truncated snippet of top search matches
        const remainingSpace = maxFileTokens - currentTokens;
        if (remainingSpace > 150) {
          const lines = res.content.split('\n');
          const snippetLines = lines.slice(0, Math.floor(lines.length * (remainingSpace / fileTokens)));
          const snippetText = snippetLines.join('\n') + '\n\n// ... [Truncated due to context limit]';
          const snippetTokens = estimateTokens(snippetText);

          contextFiles.push({
            path: res.filePath,
            relativePath: path.relative(vscodeWorkspacePath(), res.filePath).replace(/\\/g, '/'),
            content: snippetText,
            relevanceScore: score * 0.8, // discount truncated
            reason: `${reason} (Truncated)`,
            category: 'code-snippet',
            tokenCount: snippetTokens,
          });
          currentTokens += snippetTokens;
          break;
        }
      }
    }

    // 3. Assemble symbols from included files
    const fileIds = contextFiles.map(cf => {
      const dbFile = container.database.queryOne<{ id: string }>('SELECT id FROM files WHERE path = ?', [cf.path]);
      return dbFile?.id;
    }).filter(Boolean) as string[];

    const dbSymbols = fileIds.flatMap(fid => container.symbolRepository.getByFile(fid));
    const symbols = dbSymbols.map(s => ({
      name: s.name,
      kind: s.kind as any,
      signature: s.signature ?? '',
      documentation: s.documentation ?? '',
      location: {
        startLine: s.start_line,
        endLine: s.end_line,
        startCol: s.start_col ?? 0,
        endCol: s.end_col ?? 0,
      },
      complexity: s.complexity,
      dependencies: [],
      isExported: false,
      isDefault: false,
      decorators: [],
      metadata: s.metadata ? JSON.parse(s.metadata) : {},
    }));

    const totalTokens = currentTokens + estimateTokens(JSON.stringify(frameworkInfo)) + estimateTokens(JSON.stringify(conventions));

    this.logger.info(`Context assembled successfully`, {
      filesCount: contextFiles.length,
      symbolsCount: symbols.length,
      totalTokens,
      durationMs: Date.now() - startTime,
    });

    return {
      files: contextFiles,
      symbols,
      framework: frameworkInfo,
      conventions,
      dependencies,
      totalTokens,
      retrievalDuration: Date.now() - startTime,
    };
  }
}

function vscodeWorkspacePath(): string {
  const folders = ServiceContainer.getInstance().extensionContext.globalStorageUri.fsPath;
  // Fallback to active workspace
  const workspaceFolders = require('vscode').workspace.workspaceFolders;
  return workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : folders;
}
