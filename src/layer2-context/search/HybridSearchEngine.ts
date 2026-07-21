// ═══════════════════════════════════════════════════════════════
// Hybrid Search Engine — Keyword & Semantic Vector Retrieval
// ═══════════════════════════════════════════════════════════════

import { DatabaseManager } from '../database/DatabaseManager';
import { OllamaClient } from '../../layer3-reasoning/ollama/OllamaClient';
import { SearchResult } from '../../shared/types/context.types';
import { Logger } from '../../shared/Logger';
import { cosineSimilarity, decodeVector } from '../database/vectorCodec';

/**
 * Words carrying no retrieval signal in a question about code.
 *
 * Split in two because they fail differently. The English filler is noise anywhere. The
 * second group are words that *look* like search terms but appear in substantially every
 * file in a codebase — "file", "path", "code", "function" — so matching on them ranks the
 * whole repository equally. A question like "can you find the footer file path?" is
 * otherwise seven keywords of which one is the actual subject.
 *
 * This only affects which terms are *searched for*. IDF weighting below handles the
 * general case; this list handles the common case cheaply and predictably.
 */
const STOPWORDS = new Set([
  // English filler
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
  'our', 'out', 'his', 'has', 'had', 'how', 'its', 'who', 'did', 'yes', 'why', 'what',
  'when', 'where', 'which', 'this', 'that', 'with', 'from', 'they', 'them', 'then',
  'have', 'been', 'were', 'will', 'would', 'could', 'should', 'does', 'your', 'about',
  'into', 'some', 'any', 'please', 'tell', 'give', 'want', 'need', 'make', 'get',
  // Words that match nearly every file in a code repository
  'file', 'files', 'path', 'paths', 'code', 'codebase', 'function', 'functions',
  'method', 'methods', 'class', 'classes', 'line', 'lines', 'find', 'show', 'look',
  'search', 'name', 'names', 'type', 'types', 'value', 'values', 'return', 'returns',
  'import', 'imports', 'export', 'exports', 'const', 'let', 'var', 'string', 'number',
]);

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
   * Keyword search over indexed content and paths, ranked by IDF-weighted term frequency.
   *
   * Weighting by rarity is what makes this usable on a natural-language question rather
   * than a bare identifier: "can you find the footer file path?" carries one term that
   * identifies anything and six that match most of the repository.
   */
  private keywordSearch(projectId: string, query: string, limit: number): SearchResult[] {
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter(k => k.length > 2);

    if (tokens.length === 0) return [];

    // Fall back to the raw tokens when a query is *only* stopwords, so a vague question
    // still retrieves something rather than nothing.
    const meaningful = tokens.filter(k => !STOPWORDS.has(k));
    const keywords = [...new Set(meaningful.length > 0 ? meaningful : tokens)];

    // Construct SQL to search in content
    // A component can be named Footer while its implementation never contains the word
    // "footer". Search both indexed content and the relative file path.
    const likeClauses = keywords.map(() => '(content LIKE ? OR path LIKE ?)').join(' OR ');
    // Candidates are capped, so the cap has to select rather than truncate arbitrarily.
    // Ordering by how many keywords hit the path puts the file *named* after the subject
    // in the running even in a repository where hundreds of files mention it.
    const pathRank = keywords.map(() => '(CASE WHEN path LIKE ? THEN 1 ELSE 0 END)').join(' + ');

    const files = this.database.query<{ path: string; content: string; category: string }>(
      `SELECT path, content, category FROM files WHERE project_id = ? AND (${likeClauses}) ` +
        `ORDER BY (${pathRank}) DESC LIMIT 50`,
      [
        projectId,
        ...keywords.flatMap(k => [`%${k}%`, `%${k}%`]),
        ...keywords.map(k => `%${k}%`),
      ]
    );

    const weights = this.inverseDocumentFrequency(projectId, keywords);

    const scored = files.map(file => {
      let score = 0;
      const fileContentLower = file.content.toLowerCase();
      const pathLower = file.path.toLowerCase();

      for (const kw of keywords) {
        const weight = weights.get(kw) ?? 1;
        // Log-damped term frequency: a file repeating a word 500 times is more relevant
        // than one mentioning it twice, but not 250 times more.
        const count = (fileContentLower.match(new RegExp(kw, 'g')) || []).length;
        if (count > 0) score += Math.log(1 + count) * weight;
        // A path match is the strongest single signal available without embeddings.
        if (pathLower.includes(kw)) score += 2.0 * weight;
      }

      return { file, score };
    });

    // Normalized against the best score in this result set rather than a fixed divisor.
    // The scores are IDF-weighted sums with no meaningful upper bound, so a constant would
    // either saturate every result at 1.0 or squash them all toward 0 depending on query
    // length. The hybrid blend downstream assumes a 0..1 range.
    const best = Math.max(...scored.map(s => s.score), 0);

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ file, score }) => ({
        filePath: file.path,
        content: file.content,
        score: best > 0 ? parseFloat((score / best).toFixed(4)) : 0,
        matchType: 'keyword' as const,
        highlights: [],
      }));
  }

  /**
   * How much each keyword should count, by how rare it is in this project.
   *
   * Without this, term frequency alone means a file that happens to repeat a common word
   * outranks the file actually named after the subject of the question. A term present in
   * every file scores 0 and drops out; a term in one file out of hundreds dominates.
   */
  private inverseDocumentFrequency(projectId: string, keywords: string[]): Map<string, number> {
    const weights = new Map<string, number>();

    // Conditional aggregation so every keyword's document frequency comes back from one
    // pass over the table. A COUNT per keyword would be correct but would multiply the
    // scans this search costs — `content LIKE '%x%'` cannot use an index, so each one
    // reads every file body in the project.
    const counts = keywords
      .map((_, index) => `SUM(CASE WHEN content LIKE ? OR path LIKE ? THEN 1 ELSE 0 END) AS k${index}`)
      .join(', ');

    const row = this.database.queryOne<Record<string, number>>(
      `SELECT COUNT(*) AS total, ${counts} FROM files WHERE project_id = ?`,
      [...keywords.flatMap(k => [`%${k}%`, `%${k}%`]), projectId]
    );

    const total = row?.total ?? 0;
    if (total === 0) {
      for (const kw of keywords) weights.set(kw, 1);
      return weights;
    }

    keywords.forEach((kw, index) => {
      const matches = row?.[`k${index}`] ?? 0;
      // Floored rather than zeroed: a query whose every term is common should still rank
      // its results by term frequency instead of collapsing them all to nothing.
      weights.set(kw, Math.max(Math.log((total + 1) / (matches + 1)), 0.01));
    });

    return weights;
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
