import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { HybridSearchEngine } from '../../src/layer2-context/search/HybridSearchEngine';
import { DatabaseManager } from '../../src/layer2-context/database/DatabaseManager';
import { SearchResult } from '../../src/shared/types/context.types';

/**
 * A real in-memory SQLite, not a hand-rolled fake.
 *
 * The ranking fix lives partly in SQL — the candidate `LIMIT 50` is only meaningful
 * alongside its `ORDER BY` — so a fake that pattern-matched the query string would verify
 * the test's own interpretation rather than what SQLite does.
 */
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

const PROJECT = 'p1';

/** Only the columns keywordSearch reads; the real schema has more. */
function seed(files: { path: string; content: string }[]): DatabaseManager {
  const db: SqlJsDatabase = new SQL.Database();
  db.run(`CREATE TABLE files (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'source'
  )`);
  // Left empty: nothing embedded is the default state of an install, and it is what makes
  // search() skip its semantic half and fall through to the keyword path under test.
  db.run('CREATE TABLE embeddings (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, vector BLOB)');

  files.forEach((file, index) => {
    db.run('INSERT INTO files (id, project_id, path, content) VALUES (?, ?, ?, ?)', [
      `f${index}`,
      PROJECT,
      file.path,
      file.content,
    ]);
  });

  // HybridSearchEngine only ever calls query/queryOne, so a DatabaseManager standing on a
  // pre-opened sql.js handle is enough and avoids the WASM path resolution initialize()
  // does against the build output.
  const manager = new DatabaseManager('/unused');
  (manager as unknown as { db: SqlJsDatabase }).db = db;
  return manager;
}

function engineFor(files: { path: string; content: string }[]): HybridSearchEngine {
  // Embeddings are never present here, so the semantic half short-circuits and the
  // keyword path is what runs — the same as a default install.
  return new HybridSearchEngine(seed(files), {} as never);
}

async function search(
  files: { path: string; content: string }[],
  query: string,
): Promise<SearchResult[]> {
  return engineFor(files).search(PROJECT, query, 5);
}

/** A repository where "file" and "path" are everywhere and "footer" is in one place. */
const REPO = [
  { path: 'src/components/Footer.tsx', content: 'export function Footer() { return <footer/>; }' },
  { path: 'src/utils/pathUtils.ts', content: 'file path file path file path '.repeat(50) },
  { path: 'src/utils/fileReader.ts', content: 'read the file at path, file by file '.repeat(50) },
  { path: 'src/utils/walker.ts', content: 'walk each file path and yield the file '.repeat(50) },
  { path: 'src/index.ts', content: 'import { Footer } from "./components/Footer";' },
];

describe('keyword search ranking', () => {
  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  it('ranks the subject of the question above files that merely repeat filler', async () => {
    // The reported failure: this exact question seeded the local model's prompt with
    // pathUtils/fileReader/walker, because "file" and "path" outscored "footer" on raw
    // term frequency, and the footer file never made it into the seed at all.
    const results = await search(REPO, 'can you find the footer file path?');

    expect(results[0].filePath).toBe('src/components/Footer.tsx');
  });

  it('does not retrieve a file that matches only filler words', async () => {
    // pathUtils/fileReader/walker contain "file" and "path" hundreds of times and the
    // question's subject zero times. Retrieving them at all wastes the seed budget that
    // AgentService.seedPrompt spends on the local model's first prompt.
    const paths = (await search(REPO, 'can you find the footer file path?')).map(r => r.filePath);

    expect(paths).toContain('src/components/Footer.tsx');
    expect(paths).not.toContain('src/utils/pathUtils.ts');
    expect(paths).not.toContain('src/utils/walker.ts');
  });

  it('finds a component by name when its body never says the word', async () => {
    // Footer.tsx is matched on its path; the comment in HybridSearchEngine calls this out.
    const results = await search(
      [
        { path: 'src/components/Footer.tsx', content: 'export const C = () => <div/>;' },
        { path: 'src/app.ts', content: 'boot the application '.repeat(50) },
      ],
      'where is the footer component',
    );

    expect(results[0].filePath).toBe('src/components/Footer.tsx');
  });

  it('still returns something when the query is nothing but filler', async () => {
    // Falling back to the unfiltered tokens beats seeding the model with an empty block.
    const results = await search(REPO, 'can you show me the code please');

    expect(results.length).toBeGreaterThan(0);
  });

  it('returns scores in the 0..1 range the hybrid blend assumes', async () => {
    const results = await search(REPO, 'can you find the footer file path?');

    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('returns nothing for a query with no usable tokens', async () => {
    expect(await search(REPO, '?? !!')).toEqual([]);
  });
});
