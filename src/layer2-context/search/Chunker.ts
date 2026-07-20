export interface Chunk {
  text: string;
  type: string;
  symbolId?: string;
}

export interface ChunkableSymbol {
  id?: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

const MAX_CHUNK_CHARS = 4000;
const MIN_CHUNK_CHARS = 30;

/**
 * Splits a file into units worth embedding.
 *
 * Per symbol rather than per file: a single vector for a 500-line file averages every
 * concept in it into something that matches nothing well. A vector per function or
 * component is what makes "where do we validate the session token" actually return the
 * function that does it.
 *
 * Files without extracted symbols — anything that is not TS/JS today — fall back to
 * fixed-size windows so they are still searchable, just less precisely.
 */
export function chunkFile(content: string, symbols: ChunkableSymbol[] = []): Chunk[] {
  if (!content.trim()) return [];

  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  for (const symbol of symbols) {
    // Symbol line numbers come from the AST parser and can point past a file that has
    // since been edited.
    if (symbol.startLine < 1 || symbol.endLine > lines.length || symbol.endLine < symbol.startLine) {
      continue;
    }

    const body = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
    if (body.trim().length < MIN_CHUNK_CHARS) continue;

    // The name and kind are prepended so a natural-language query matches the symbol's
    // identity, not only its implementation.
    const text = `${symbol.kind} ${symbol.name}\n${body}`;
    chunks.push({
      text: text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text,
      type: symbol.kind,
      symbolId: symbol.id,
    });
  }

  if (chunks.length === 0) {
    return windowChunks(content);
  }

  return chunks;
}

/** Fixed-size fallback for files with no symbol information. */
function windowChunks(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (let offset = 0; offset < content.length; offset += MAX_CHUNK_CHARS) {
    const text = content.slice(offset, offset + MAX_CHUNK_CHARS);
    if (text.trim().length >= MIN_CHUNK_CHARS) {
      chunks.push({ text, type: 'file' });
    }
  }
  return chunks;
}
