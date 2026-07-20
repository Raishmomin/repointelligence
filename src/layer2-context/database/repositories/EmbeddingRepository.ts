// ═══════════════════════════════════════════════════════════════
// Embedding Repository — Vector storage for semantic search
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { DatabaseManager } from '../DatabaseManager';
import { EmbeddingRecord } from '../../../shared/types/database.types';

export class EmbeddingRepository {
  constructor(private db: DatabaseManager) {}

  /** Store embeddings for a file's chunks. Replaces existing. */
  replaceForFile(fileId: string, chunks: { text: string; type: string; vector: Float32Array }[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM embeddings WHERE file_id = ?', [fileId]);
      for (const chunk of chunks) {
        this.db.run(
          'INSERT INTO embeddings (id, file_id, symbol_id, chunk_text, chunk_type, vector, created_at) VALUES (?,?,?,?,?,?,?)',
          [uuid(), fileId, null, chunk.text, chunk.type, Buffer.from(chunk.vector.buffer), Date.now()],
        );
      }
    });
  }

  /** Get all embeddings for a project (for in-memory cosine similarity). */
  getAllForProject(projectId: string): (EmbeddingRecord & { relative_path: string })[] {
    return this.db.query(
      `SELECT e.*, f.relative_path FROM embeddings e
       JOIN files f ON e.file_id = f.id WHERE f.project_id = ?`, [projectId]);
  }

  /** Delete embeddings for a file. */
  deleteForFile(fileId: string): void {
    this.db.run('DELETE FROM embeddings WHERE file_id = ?', [fileId]);
  }
}
