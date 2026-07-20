import * as vscode from 'vscode';
import { Logger } from '../../shared/Logger';
import { OllamaClient } from '../../layer3-reasoning/ollama/OllamaClient';
import { EmbeddingRepository } from '../database/repositories/EmbeddingRepository';
import { toFloat32 } from '../database/vectorCodec';
import { chunkFile, ChunkableSymbol } from './Chunker';

export interface IndexableFile {
  fileId: string;
  path: string;
  content: string;
  symbols?: ChunkableSymbol[];
}

export interface IndexProgress {
  report(message: string): void;
}

/**
 * Generates and stores embeddings for scanned files.
 *
 * Embedding a large repository means thousands of sequential calls to a local model — on a
 * monorepo that is many minutes of work. It is therefore off by default, cancellable at
 * every step, and reports progress, because the failure mode of getting this wrong is a
 * frozen editor and a feature nobody trusts afterwards.
 */
export class EmbeddingIndexer {
  constructor(
    private readonly embeddings: EmbeddingRepository,
    private readonly ollama: OllamaClient,
    private readonly logger: Logger = Logger.getInstance(),
  ) {}

  static isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('repo-intelligence')
      .get<boolean>('search.enableEmbeddings', false);
  }

  /**
   * @returns the number of files embedded; 0 when disabled, cancelled, or unavailable.
   */
  async indexFiles(
    files: IndexableFile[],
    token: vscode.CancellationToken,
    progress?: IndexProgress,
  ): Promise<number> {
    if (!EmbeddingIndexer.isEnabled()) return 0;

    // Embeddings always come from Ollama: the Anthropic API has no embeddings endpoint,
    // so this is unavailable whenever Ollama is not running, regardless of chat provider.
    const health = await this.ollama.checkHealth();
    if (!health.available) {
      this.logger.info(
        'Embeddings are enabled but Ollama is unreachable; retrieval stays keyword-only.',
      );
      return 0;
    }

    let embedded = 0;
    for (const [index, file] of files.entries()) {
      if (token.isCancellationRequested) {
        this.logger.info(`Embedding cancelled after ${embedded} of ${files.length} files.`);
        break;
      }

      const chunks = chunkFile(file.content, file.symbols ?? []);
      if (!chunks.length) continue;

      progress?.report(`Embedding ${index + 1}/${files.length}: ${file.path}`);

      try {
        const vectors: { text: string; type: string; symbolId?: string; vector: Float32Array }[] = [];
        for (const chunk of chunks) {
          if (token.isCancellationRequested) break;
          const values = await this.ollama.getEmbedding(chunk.text);
          // An empty vector means the model is missing or errored; storing it would add a
          // row that can never match anything.
          if (!values.length) continue;
          vectors.push({ ...chunk, vector: toFloat32(values) });
        }

        if (vectors.length) {
          this.embeddings.replaceForFile(file.fileId, vectors);
          embedded++;
        }
      } catch (error) {
        // One bad file should not abort indexing the rest.
        this.logger.warn(`Failed to embed ${file.path}`, { error: String(error) });
      }
    }

    return embedded;
  }
}
