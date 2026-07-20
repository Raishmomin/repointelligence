// ═══════════════════════════════════════════════════════════════
// Embedding Repository — Vector storage for semantic search
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { DatabaseManager } from '../DatabaseManager';
import { EmbeddingRecord } from '../../../shared/types/database.types';
import { encodeVector } from '../vectorCodec';

export class EmbeddingRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Store embeddings for a file's chunks, replacing any that exist.
   *
   * Encoding goes through vectorCodec so the write matches what semanticSearch reads —
   * these two ends previously disagreed, which is why no embedding was ever retrievable.
   */
  replaceForFile(
    fileId: string,
    chunks: { text: string; type: string; symbolId?: string; vector: Float32Array }[],
  ): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM embeddings WHERE file_id = ?', [fileId]);
      for (const chunk of chunks) {
        this.db.run(
          'INSERT INTO embeddings (id, file_id, symbol_id, chunk_text, chunk_type, vector, created_at) VALUES (?,?,?,?,?,?,?)',
          [
            uuid(),
            fileId,
            chunk.symbolId ?? null,
            chunk.text,
            chunk.type,
            encodeVector(chunk.vector),
            Date.now(),
          ],
        );
      }
    });
  }

  /** Whether this project has any embeddings; semantic search is pointless without them. */
  countForProject(projectId: string): number {
    const row = this.db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM embeddings e JOIN files f ON e.file_id = f.id WHERE f.project_id = ?',
      [projectId],
    );
    return row?.count ?? 0;
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
