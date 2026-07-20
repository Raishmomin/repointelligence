// ═══════════════════════════════════════════════════════════════
// File Repository — CRUD operations for file records
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { DatabaseManager } from '../DatabaseManager';
import { FileRecord } from '../../../shared/types/database.types';
import { ScannedFile } from '../../../shared/types/scanner.types';

export class FileRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Upsert a batch of scanned files into the database.
   * Uses content_hash to skip files that haven't changed.
   */
  upsertFiles(projectId: string, files: ScannedFile[]): { inserted: number; updated: number; unchanged: number } {
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    this.db.transaction(() => {
      for (const file of files) {
        const existing = this.db.queryOne<FileRecord>(
          'SELECT id, content_hash FROM files WHERE project_id = ? AND path = ?',
          [projectId, file.path],
        );

        if (existing) {
          if (existing.content_hash !== file.hash) {
            this.db.run(
              `UPDATE files SET 
                language = ?, category = ?, content = ?, content_hash = ?, 
                size = ?, last_modified = ?, last_indexed = NULL
              WHERE id = ?`,
              [file.language, file.category, file.content, file.hash, file.size, file.lastModified, existing.id],
            );
            updated++;
          } else {
            unchanged++;
          }
        } else {
          const id = uuid();
          this.db.run(
            `INSERT INTO files (id, project_id, path, relative_path, language, category, content, content_hash, size, last_modified)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, projectId, file.path, file.relativePath, file.language, file.category, file.content, file.hash, file.size, file.lastModified],
          );
          inserted++;
        }
      }
    });

    return { inserted, updated, unchanged };
  }

  /**
   * Get all files for a project.
   */
  getByProject(projectId: string): FileRecord[] {
    return this.db.query<FileRecord>(
      'SELECT * FROM files WHERE project_id = ? ORDER BY relative_path',
      [projectId],
    );
  }

  /**
   * Get files by category.
   */
  getByCategory(projectId: string, category: string): FileRecord[] {
    return this.db.query<FileRecord>(
      'SELECT * FROM files WHERE project_id = ? AND category = ?',
      [projectId, category],
    );
  }

  /**
   * Get a file by its absolute path.
   */
  getByPath(projectId: string, filePath: string): FileRecord | null {
    return this.db.queryOne<FileRecord>(
      'SELECT * FROM files WHERE project_id = ? AND path = ?',
      [projectId, filePath],
    );
  }

  /**
   * Delete a file and cascade-delete its symbols, deps, and embeddings.
   */
  delete(fileId: string): void {
    this.db.run('DELETE FROM files WHERE id = ?', [fileId]);
  }

  /**
   * Remove files that no longer exist on disk.
   */
  removeStaleFiles(projectId: string, currentPaths: Set<string>): number {
    const allFiles = this.getByProject(projectId);
    let removed = 0;

    this.db.transaction(() => {
      for (const file of allFiles) {
        if (!currentPaths.has(file.path)) {
          this.delete(file.id);
          removed++;
        }
      }
    });

    return removed;
  }

  /**
   * Mark a file as indexed (embeddings generated).
   */
  markIndexed(fileId: string): void {
    this.db.run('UPDATE files SET last_indexed = ? WHERE id = ?', [Date.now(), fileId]);
  }

  /**
   * Get files that need (re-)indexing.
   */
  getUnindexedFiles(projectId: string): FileRecord[] {
    return this.db.query<FileRecord>(
      'SELECT * FROM files WHERE project_id = ? AND (last_indexed IS NULL OR last_indexed < last_modified)',
      [projectId],
    );
  }

  /**
   * Get scan statistics for a project.
   */
  getStats(projectId: string): { byLanguage: Record<string, number>; byCategory: Record<string, number>; totalFiles: number; totalSize: number } {
    const files = this.getByProject(projectId);
    const byLanguage: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let totalSize = 0;

    for (const file of files) {
      byLanguage[file.language] = (byLanguage[file.language] || 0) + 1;
      byCategory[file.category] = (byCategory[file.category] || 0) + 1;
      totalSize += file.size;
    }

    return { byLanguage, byCategory, totalFiles: files.length, totalSize };
  }
}
