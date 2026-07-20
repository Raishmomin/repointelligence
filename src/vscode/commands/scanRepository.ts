// ═══════════════════════════════════════════════════════════════
// Scan Repository Command — Full project analysis
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { v4 as uuid } from 'uuid';
import { ServiceContainer } from '../../container';
import { Logger } from '../../shared/Logger';
import { EventBus } from '../../shared/EventBus';
import { ConventionDetector } from '../../layer2-context/validation/ConventionDetector';
import { EmbeddingIndexer } from '../../layer2-context/search/EmbeddingIndexer';

/**
 * Execute a full repository scan with progress reporting.
 * Walks files, classifies them, detects frameworks, and stores
 * everything in the knowledge database.
 */
let isScanning = false;

export async function scanRepository(): Promise<void> {
  if (isScanning) {
    vscode.window.showWarningMessage('A repository scan is already in progress.');
    return;
  }
  isScanning = true;

  const container = ServiceContainer.getInstance();
  const logger = Logger.getInstance();

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('No workspace folder open. Open a project folder first.');
    isScanning = false;
    return;
  }

  const rootPath = workspaceFolders[0].uri.fsPath;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Repository Intelligence',
        cancellable: true,
      },
      async (progress, token) => {
        try {
          // 1. Initialize database if needed
          progress.report({ message: 'Initializing database...' });
          await container.database.initialize();

          // 2. Get config
          const config = vscode.workspace.getConfiguration('repo-intelligence');
          const excludePatterns = config.get<string[]>('scan.excludePatterns', []);

          // 3. Scan repository
          progress.report({ message: 'Scanning files...' });
          const scanResult = await container.scanner.scan(rootPath, excludePatterns, token);

          if (token.isCancellationRequested) return;

          // 4. Detect framework
          progress.report({ message: 'Detecting framework...' });
          const filePaths = scanResult.files.map(f => f.relativePath);
          const frameworkInfo = await container.frameworkDetector.detect(
            rootPath, scanResult.packages, filePaths,
          );
          scanResult.framework = frameworkInfo;

          // 5. Store project record
          progress.report({ message: 'Saving to knowledge base...' });
          const now = Date.now();
          const existing = container.database.queryOne<{ id: string }>(
            'SELECT id FROM projects WHERE root_path = ?', [rootPath],
          );

          const projectId = existing?.id ?? uuid();
          if (existing) {
            container.database.run(
              'UPDATE projects SET framework = ?, metadata = ?, updated_at = ?, last_scan = ? WHERE id = ?',
              [frameworkInfo.primary, JSON.stringify(frameworkInfo), now, now, projectId],
            );
          } else {
            container.database.run(
              'INSERT INTO projects (id, name, root_path, framework, metadata, created_at, updated_at, last_scan) VALUES (?,?,?,?,?,?,?,?)',
              [projectId, scanResult.packages.name, rootPath, frameworkInfo.primary, JSON.stringify(frameworkInfo), now, now, now],
            );
          }

          // 6. Upsert files
          progress.report({ message: 'Indexing files...' });
          const fileResult = container.fileRepository.upsertFiles(projectId, scanResult.files);

          // 7. Clean up stale files
          const currentPaths = new Set(scanResult.files.map(f => f.path));
          const removed = container.fileRepository.removeStaleFiles(projectId, currentPaths);

          // 8. AST Parsing and Dependency Analysis
          progress.report({ message: 'Running AST analysis...' });
          container.astParser.initialize(rootPath);
          
          // Add only TS/JS source files to the AST project
          const sourceFiles = scanResult.files.filter(f => 
            f.language === 'typescript' || 
            f.language === 'typescriptreact' || 
            f.language === 'javascript' || 
            f.language === 'javascriptreact'
          );
          container.astParser.addFiles(sourceFiles.map(f => f.path));
          const parsedFiles = container.astParser.parseAll(rootPath);

          // Build Dependency Graph
          progress.report({ message: 'Building dependency graph...' });
          container.dependencyGraph.build(parsedFiles);

          // Get map of file paths to database IDs
          const dbFiles = container.fileRepository.getByProject(projectId);
          const filePathToId = new Map<string, string>();
          for (const f of dbFiles) {
            filePathToId.set(f.path, f.id);
          }

          // Save symbols, dependencies, patterns to database
          progress.report({ message: 'Saving symbols and dependencies...' });
          for (const parsed of parsedFiles) {
            const fileId = filePathToId.get(parsed.path);
            if (!fileId) continue;

            // Save symbols
            container.symbolRepository.replaceForFile(fileId, parsed.symbols);

            // Save dependencies
            container.dependencyRepository.replaceForFile(fileId, parsed.imports, filePathToId);

            // Save patterns
            container.database.run('DELETE FROM patterns WHERE file_id = ?', [fileId]);
            for (const pat of parsed.patterns) {
              container.database.run(
                `INSERT INTO patterns (id, project_id, pattern, file_id, symbol_name, confidence, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [uuid(), projectId, pat.type, fileId, pat.symbolName, pat.confidence, JSON.stringify({ evidence: pat.evidence })]
              );
            }
          }

          // 9. Detect Conventions
          progress.report({ message: 'Detecting coding conventions...' });
          const conventionDetector = new ConventionDetector();
          const conventions = conventionDetector.detect(parsedFiles);
          container.database.transaction(() => {
            container.database.run('DELETE FROM conventions WHERE project_id = ?', [projectId]);
            for (const conv of conventions) {
              container.database.run(
                `INSERT INTO conventions (id, project_id, category, rule, examples, confidence)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [uuid(), projectId, conv.category, conv.rule, JSON.stringify(conv.examples), conv.confidence]
              );
            }
          });

          // 9.5 Generate embeddings for semantic search.
          //     Off by default: embedding a large repository is thousands of local model
          //     calls, so it is opt-in, cancellable, and degrades to keyword-only search
          //     rather than blocking the scan.
          if (EmbeddingIndexer.isEnabled() && !token.isCancellationRequested) {
            progress.report({ message: 'Generating embeddings...' });
            const indexer = new EmbeddingIndexer(container.embeddingRepository, container.ollamaClient);
            const indexable = parsedFiles.flatMap(parsed => {
              const fileId = filePathToId.get(parsed.path);
              if (!fileId) return [];
              const content = scanResult.files.find(file => file.path === parsed.path)?.content;
              if (!content) return [];
              // SymbolInfo keeps line numbers under `location`; Chunker wants them flat.
              const symbols = parsed.symbols.map(symbol => ({
                name: symbol.name,
                kind: symbol.kind,
                startLine: symbol.location.startLine,
                endLine: symbol.location.endLine,
              }));
              return [{ fileId, path: parsed.path, content, symbols }];
            });
            const embedded = await indexer.indexFiles(indexable, token, {
              report: message => progress.report({ message }),
            });
            if (embedded) logger.info(`Generated embeddings for ${embedded} files.`);
          }
          // Whether embeddings exist is cached per project; a scan is when that changes.
          container.hybridSearchEngine.invalidateEmbeddingCache();

          // 10. Save database
          container.database.save();

          // Emit scan:completed to notify tree views and chat views
          scanResult.projectId = projectId;
          EventBus.getInstance().emit('scan:completed', scanResult);

          // 11. Report results
          const totalSymbols = parsedFiles.reduce((sum, f) => sum + f.symbols.length, 0);
          const summary = [
            `✅ Scan complete in ${(scanResult.duration / 1000).toFixed(1)}s`,
            `📁 ${scanResult.stats.totalFiles} files (${fileResult.inserted} new, ${fileResult.updated} updated, ${removed} removed)`,
            `🔣 ${totalSymbols} symbols extracted & dependency graph built`,
            `🎨 ${conventions.length} coding conventions detected`,
            `🏗️ Framework: ${frameworkInfo.primary}${frameworkInfo.secondary.length ? ` + ${frameworkInfo.secondary.join(', ')}` : ''}`,
            frameworkInfo.router !== 'unknown' ? `🛣️ Router: ${frameworkInfo.router}` : '',
            frameworkInfo.stateManagement.length ? `📦 State: ${frameworkInfo.stateManagement.join(', ')}` : '',
            frameworkInfo.orm ? `🗄️ ORM: ${frameworkInfo.orm}` : '',
          ].filter(Boolean).join('\n');

          logger.info(summary);
          vscode.window.showInformationMessage(
            `Repo Intelligence: ${scanResult.stats.totalFiles} files indexed | Framework: ${frameworkInfo.primary}`,
            'Show Details',
          ).then(selection => {
            if (selection === 'Show Details') {
              logger.show();
            }
          });

        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error('Scan failed', error);
          vscode.window.showErrorMessage(`Repository scan failed: ${msg}`);
        }
      },
    );
  } finally {
    isScanning = false;
  }
}
