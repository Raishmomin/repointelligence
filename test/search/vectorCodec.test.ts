import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  toFloat32,
} from '../../src/layer2-context/database/vectorCodec';

describe('vector encode/decode round trip', () => {
  it('preserves values exactly', () => {
    const original = toFloat32([0.1, -0.5, 0.9, 0]);
    expect(Array.from(decodeVector(encodeVector(original)))).toEqual(Array.from(original));
  });

  it('preserves length', () => {
    const original = new Float32Array(768).fill(0.25);
    expect(decodeVector(encodeVector(original))).toHaveLength(768);
  });

  it('uses 4 bytes per dimension', () => {
    // The size argument for BLOB over JSON: 768 dims is ~3 KB, not ~12 KB.
    expect(encodeVector(new Float32Array(768)).byteLength).toBe(3072);
  });

  it('handles negative and fractional values', () => {
    const original = toFloat32([-0.999999, 0.000001, -1, 1]);
    const restored = decodeVector(encodeVector(original));
    for (let index = 0; index < original.length; index++) {
      expect(restored[index]).toBeCloseTo(original[index], 6);
    }
  });

  it('handles an empty vector', () => {
    expect(decodeVector(encodeVector(new Float32Array(0)))).toHaveLength(0);
  });

  describe('views onto a larger buffer', () => {
    it('encodes only the view, not the whole backing buffer', () => {
      // subarray() returns a window onto a shared buffer. Encoding `.buffer` directly
      // would capture the neighbouring values too, storing them as trailing garbage.
      const backing = toFloat32([1, 2, 3, 4, 5, 6, 7, 8]);
      const view = backing.subarray(2, 5);

      const encoded = encodeVector(view);
      expect(encoded.byteLength).toBe(12);
      expect(Array.from(decodeVector(encoded))).toEqual([3, 4, 5]);
    });

    it('does not alias the source buffer after decoding', () => {
      const original = toFloat32([1, 2, 3]);
      const encoded = encodeVector(original);
      const decoded = decodeVector(encoded);

      original[0] = 99;
      expect(decoded[0]).toBe(1);
    });
  });

  it('rejects a blob that is not a whole number of floats', () => {
    // Better to fail loudly than to silently read a truncated vector.
    expect(() => decodeVector(new Uint8Array(7))).toThrow(/Corrupt embedding/);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const vector = toFloat32([1, 2, 3]);
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(toFloat32([1, 0]), toFloat32([0, 1]))).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity(toFloat32([1, 2]), toFloat32([-1, -2]))).toBeCloseTo(-1, 10);
  });

  it('ignores magnitude, comparing direction only', () => {
    expect(cosineSimilarity(toFloat32([1, 1]), toFloat32([10, 10]))).toBeCloseTo(1, 10);
  });

  it('never returns a value outside [-1, 1]', () => {
    // Floating-point error can otherwise push an identical pair fractionally past 1,
    // which would sort ahead of a genuine exact match.
    const vector = new Float32Array(512).fill(0.9999999);
    expect(cosineSimilarity(vector, vector)).toBeLessThanOrEqual(1);
    expect(cosineSimilarity(vector, vector)).toBeGreaterThanOrEqual(-1);
  });

  describe('degenerate input returns 0 rather than NaN', () => {
    it('mismatched lengths', () => {
      expect(cosineSimilarity(toFloat32([1, 2, 3]), toFloat32([1, 2]))).toBe(0);
    });

    it('empty vectors', () => {
      expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
    });

    it('a zero vector', () => {
      // NaN here would sort unpredictably and corrupt ranking.
      expect(cosineSimilarity(toFloat32([0, 0, 0]), toFloat32([1, 2, 3]))).toBe(0);
    });

    it('both vectors zero', () => {
      expect(cosineSimilarity(toFloat32([0, 0]), toFloat32([0, 0]))).toBe(0);
    });
  });

  it('accepts plain arrays as well as typed arrays', () => {
    // The query vector arrives from Ollama as number[].
    expect(cosineSimilarity([1, 0, 0], toFloat32([1, 0, 0]))).toBeCloseTo(1, 10);
  });
});
