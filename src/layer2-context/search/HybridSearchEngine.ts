// ═══════════════════════════════════════════════════════════════
// Hybrid Search Engine — Keyword & Semantic Vector Retrieval
// ═══════════════════════════════════════════════════════════════

import { DatabaseManager } from '../database/DatabaseManager';
import { OllamaClient } from '../../layer3-reasoning/ollama/OllamaClient';
import { SearchResult } from '../../shared/types/context.types';
import { Logger } from '../../shared/Logger';

export class HybridSearchEngine {
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

    let semanticResults: SearchResult[] = [];
    if (options.enableSemantic !== false) {
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
   * Semantic vector similarity search.
   */
  private async semanticSearch(projectId: string, query: string, limit: number): Promise<SearchResult[]> {
    const queryVector = await this.ollamaClient.getEmbedding(query);
    if (queryVector.length === 0) return [];

    // Fetch all vectors in database
    const dbEmbeddings = this.database.query<{ file_id: string; embedding: any }>(
      `SELECT file_id, embedding FROM embeddings 
       WHERE file_id IN (SELECT id FROM files WHERE project_id = ?)`,
      [projectId]
    );

    const scores: { fileId: string; score: number }[] = [];

    for (const emb of dbEmbeddings) {
      try {
        const vector: number[] = Array.isArray(emb.embedding) 
          ? emb.embedding 
          : JSON.parse(emb.embedding);

        const score = this.cosineSimilarity(queryVector, vector);
        scores.push({ fileId: emb.file_id, score });
      } catch {
        // Skip malformed vectors
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

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    
    const len = Math.min(vecA.length, vecB.length);
    for (let i = 0; i < len; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
