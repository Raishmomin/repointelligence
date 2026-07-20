// ═══════════════════════════════════════════════════════════════
// Symbol Repository — CRUD for extracted code symbols
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { DatabaseManager } from '../DatabaseManager';
import { SymbolRecord } from '../../../shared/types/database.types';
import { SymbolInfo } from '../../../shared/types/ast.types';

export class SymbolRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Replace all symbols for a file (used after re-parsing).
   */
  replaceForFile(fileId: string, symbols: SymbolInfo[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM symbols WHERE file_id = ?', [fileId]);

      for (const sym of symbols) {
        this.db.run(
          `INSERT INTO symbols (id, file_id, name, kind, signature, documentation, start_line, end_line, start_col, end_col, complexity, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuid(), fileId, sym.name, sym.kind, sym.signature,
            sym.documentation, sym.location.startLine, sym.location.endLine,
            sym.location.startCol, sym.location.endCol, sym.complexity,
            JSON.stringify(sym.metadata),
          ],
        );
      }
    });
  }

  /**
   * Search symbols by name (prefix match).
   */
  searchByName(projectId: string, query: string, limit = 50): SymbolRecord[] {
    return this.db.query<SymbolRecord>(
      `SELECT s.* FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.project_id = ? AND s.name LIKE ?
       ORDER BY s.name LIMIT ?`,
      [projectId, `${query}%`, limit],
    );
  }

  /**
   * Get all symbols for a file.
   */
  getByFile(fileId: string): SymbolRecord[] {
    return this.db.query<SymbolRecord>(
      'SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line',
      [fileId],
    );
  }

  /**
   * Get symbols by kind across the project.
   */
  getByKind(projectId: string, kind: string): SymbolRecord[] {
    return this.db.query<SymbolRecord>(
      `SELECT s.* FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.project_id = ? AND s.kind = ?
       ORDER BY s.name`,
      [projectId, kind],
    );
  }

  /**
   * Get all exported symbols (for dependency resolution).
   */
  getExported(projectId: string): SymbolRecord[] {
    return this.db.query<SymbolRecord>(
      `SELECT s.* FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.project_id = ?
       AND json_extract(s.metadata, '$.isExported') = 1
       ORDER BY s.name`,
      [projectId],
    );
  }
}
