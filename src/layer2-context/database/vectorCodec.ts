/**
 * Encodes embedding vectors for the SQLite BLOB column.
 *
 * Raw Float32 bytes rather than JSON: a 768-dimension vector is ~3 KB as a BLOB against
 * ~12 KB as JSON text, and a repository's worth of vectors is the largest thing in the
 * database. sql.js also has to serialise the whole file on every save, so the size
 * difference shows up directly as save latency.
 *
 * Both ends must agree. They previously did not — the writer stored raw bytes while the
 * reader called JSON.parse — which is why nothing was ever retrievable.
 */

export function encodeVector(vector: Float32Array): Uint8Array {
  // `vector.buffer` may be a larger backing store with this array as a window onto part of
  // it — Float32Array.subarray() and many embedding libraries return exactly that. Copying
  // the whole buffer would store neighbouring vectors as trailing garbage, so slice to
  // this array's own bytes.
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function decodeVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`Corrupt embedding: ${blob.byteLength} bytes is not a whole number of float32 values.`);
  }
  // Copy rather than aliasing: the source may be a view whose byteOffset is not a multiple
  // of 4, which Float32Array cannot wrap directly.
  const copy = blob.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function toFloat32(values: number[]): Float32Array {
  return Float32Array.from(values);
}

/**
 * Cosine similarity, returning 0 for any degenerate input rather than NaN — a NaN score
 * would sort unpredictably and silently corrupt ranking.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    magnitudeA += a[index] * a[index];
    magnitudeB += b[index] * b[index];
  }

  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  if (denominator === 0) return 0;

  // Floating-point error can push an identical pair fractionally past 1.
  return Math.max(-1, Math.min(1, dot / denominator));
}
