// ═══════════════════════════════════════════════════════════════
// Dependency Repository — Import/export relationship storage
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { DatabaseManager } from '../DatabaseManager';
import { DependencyRecord } from '../../../shared/types/database.types';
import { ImportInfo } from '../../../shared/types/ast.types';

export class DependencyRepository {
  constructor(private db: DatabaseManager) {}

  replaceForFile(sourceFileId: string, imports: ImportInfo[], filePathToId: Map<string, string>): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM dependencies WHERE source_file_id = ?', [sourceFileId]);
      for (const imp of imports) {
        const targetFileId = imp.resolvedPath ? filePathToId.get(imp.resolvedPath) ?? null : null;
        this.db.run(
          `INSERT INTO dependencies (id, source_file_id, target_file_id, source_symbol, target_symbol, dep_type, is_external, module_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuid(), sourceFileId, targetFileId, null, imp.specifiers.join(', '),
           imp.isTypeOnly ? 'type-import' : (imp.isDynamic ? 'dynamic' : 'import'),
           imp.isExternal ? 1 : 0, imp.isExternal ? imp.source : null],
        );
      }
    });
  }

  getDependencies(fileId: string): DependencyRecord[] {
    return this.db.query<DependencyRecord>('SELECT * FROM dependencies WHERE source_file_id = ?', [fileId]);
  }

  getDependents(fileId: string): DependencyRecord[] {
    return this.db.query<DependencyRecord>('SELECT * FROM dependencies WHERE target_file_id = ?', [fileId]);
  }

  getExternalDeps(projectId: string): { module_name: string; count: number }[] {
    return this.db.query(
      `SELECT d.module_name, COUNT(*) as count FROM dependencies d
       JOIN files f ON d.source_file_id = f.id
       WHERE f.project_id = ? AND d.is_external = 1 AND d.module_name IS NOT NULL
       GROUP BY d.module_name ORDER BY count DESC`, [projectId]);
  }

  getMostImported(projectId: string, limit = 20): { file_id: string; path: string; import_count: number }[] {
    return this.db.query(
      `SELECT d.target_file_id as file_id, f.relative_path as path, COUNT(*) as import_count
       FROM dependencies d JOIN files f ON d.target_file_id = f.id
       WHERE f.project_id = ? AND d.is_external = 0 AND d.target_file_id IS NOT NULL
       GROUP BY d.target_file_id ORDER BY import_count DESC LIMIT ?`, [projectId, limit]);
  }
}
