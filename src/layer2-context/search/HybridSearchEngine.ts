// ═══════════════════════════════════════════════════════════════
// Hybrid Search Engine — Keyword & Semantic Vector Retrieval
// ═══════════════════════════════════════════════════════════════

import { DatabaseManager } from '../database/DatabaseManager';
import { OllamaClient } from '../../layer3-reasoning/ollama/OllamaClient';
import { SearchResult } from '../../shared/types/context.types';
import { Logger } from '../../shared/Logger';
import { cosineSimilarity, decodeVector } from '../database/vectorCodec';

export class HybridSearchEngine {
  private readonly embeddingsPresent = new Map<string, boolean>();

  private logger = Logger.getInstance();

  constructor(
    private database: DatabaseManager,
    private ollamaClient: OllamaClient
  ) {}

  /**
   * Search files using keyword-based matching, semantic vector distance, or both.
   */
  async search(
    projectId: string,
    query: string,
    limit = 10,
    options: { enableSemantic?: boolean } = {}
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const keywordResults = this.keywordSearch(projectId, query, limit * 2);

    // Semantic search costs an embedding round trip per query, so it is skipped entirely
    // when nothing has been embedded — which is the default, since embedding generation is
    // opt-in. Callers no longer have to pass enableSemantic:false to avoid the cost.
    let semanticResults: SearchResult[] = [];
    if (options.enableSemantic !== false && this.hasEmbeddings(projectId)) {
      semanticResults = await this.semanticSearch(projectId, query, limit * 2);
    }

    // Combine using Reciprocal Rank Fusion (RRF) or normalized scores
    const merged = new Map<string, { result: SearchResult; keywordScore: number; semanticScore: number }>();

    for (const res of keywordResults) {
      merged.set(res.filePath, { result: res, keywordScore: res.score, semanticScore: 0 });
    }

    for (const res of semanticResults) {
      const existing = merged.get(res.filePath);
      if (existing) {
        existing.semanticScore = res.score;
        existing.result.matchType = 'hybrid';
      } else {
        merged.set(res.filePath, { result: res, keywordScore: 0, semanticScore: res.score });
      }
    }

    // Calculate hybrid scores
    for (const [filePath, scores] of merged.entries()) {
      // 0.4 keyword + 0.6 semantic weight
      const hybridScore = scores.keywordScore * 0.4 + scores.semanticScore * 0.6;
      scores.result.score = parseFloat(hybridScore.toFixed(4));
      results.push(scores.result);
    }

    // Sort by score descending and limit results
    results.sort((a, b) => b.score - a.score);
    this.logger.debug(`Hybrid search completed for query "${query}"`, {
      resultsFound: results.length,
      topScores: results.slice(0, 3).map(r => ({ path: r.filePath.split('/').pop(), score: r.score })),
    });

    return results.slice(0, limit);
  }

  /**
   * Fast keyword search using SQL LIKE querying and token frequency heuristic.
   */
  private keywordSearch(projectId: string, query: string, limit: number): SearchResult[] {
    const keywords = query
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter(k => k.length > 2);

    if (keywords.length === 0) return [];

    // Construct SQL to search in content
    // A component can be named Footer while its implementation never contains the word
    // "footer". Search both indexed content and the relative file path.
    const likeClauses = keywords.map(() => '(content LIKE ? OR path LIKE ?)').join(' OR ');
    const params = [projectId, ...keywords.flatMap(k => [`%${k}%`, `%${k}%`])];

    const files = this.database.query<{ path: string; content: string; category: string }>(
      `SELECT path, content, category FROM files WHERE project_id = ? AND (${likeClauses}) LIMIT 50`,
      params
    );

    const results: SearchResult[] = [];
    for (const file of files) {
      // Calculate tf-idf score style heuristics
      let score = 0;
      const fileContentLower = file.content.toLowerCase();

      for (const kw of keywords) {
        const count = (fileContentLower.match(new RegExp(kw, 'g')) || []).length;
        if (count > 0) {
          score += count * 0.1; // term frequency
        }
      }

      // Boost score slightly if keyword is in the file path
      const pathLower = file.path.toLowerCase();
      for (const kw of keywords) {
        if (pathLower.includes(kw)) {
          score += 1.0;
        }
      }

      // Normalize score between 0 and 1
      const normalizedScore = Math.min(score / 5.0, 1.0);

      results.push({
        filePath: file.path,
        content: file.content,
        score: normalizedScore,
        matchType: 'keyword',
        highlights: [],
      });
    }

    return results.slice(0, limit);
  }

  /**
   * Cached per project: this is checked on every search, and the answer only changes on a
   * rescan. A count query per keystroke-driven search would be wasteful.
   */
  private hasEmbeddings(projectId: string): boolean {
    const cached = this.embeddingsPresent.get(projectId);
    if (cached !== undefined) return cached;

    const row = this.database.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM embeddings e JOIN files f ON e.file_id = f.id WHERE f.project_id = ?',
      [projectId],
    );
    const present = (row?.count ?? 0) > 0;
    this.embeddingsPresent.set(projectId, present);
    return present;
  }

  /** Called after a scan, when embeddings may have appeared or been cleared. */
  invalidateEmbeddingCache(): void {
    this.embeddingsPresent.clear();
  }

  /**
   * Semantic vector similarity search.
   */
  private async semanticSearch(projectId: string, query: string, limit: number): Promise<SearchResult[]> {
    const queryVector = await this.ollamaClient.getEmbedding(query);
    if (queryVector.length === 0) return [];

    // The column is `vector`, not `embedding` — selecting the wrong name made sql.js throw
    // at prepare time, so this whole path failed rather than degrading.
    const dbEmbeddings = this.database.query<{ file_id: string; vector: Uint8Array }>(
      `SELECT file_id, vector FROM embeddings
       WHERE file_id IN (SELECT id FROM files WHERE project_id = ?)`,
      [projectId]
    );

    const scores: { fileId: string; score: number }[] = [];

    for (const emb of dbEmbeddings) {
      try {
        // Decoded with the same codec used to write it. This previously called
        // JSON.parse on raw Float32 bytes and could never have succeeded.
        const vector = decodeVector(emb.vector);
        scores.push({ fileId: emb.file_id, score: cosineSimilarity(queryVector, vector) });
      } catch {
        // One corrupt row should not sink the whole query.
      }
    }

    // Sort by similarity descending
    scores.sort((a, b) => b.score - a.score);
    const topScores = scores.slice(0, limit);

    const results: SearchResult[] = [];
    for (const entry of topScores) {
      const file = this.database.queryOne<{ path: string; content: string }>(
        'SELECT path, content FROM files WHERE id = ?',
        [entry.fileId]
      );
      if (file) {
        results.push({
          filePath: file.path,
          content: file.content,
          score: entry.score,
          matchType: 'semantic',
          highlights: [],
        });
      }
    }

    return results;
  }

}
