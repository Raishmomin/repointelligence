import type { Database as SqlJsDatabase } from 'sql.js';

/**
 * Records which provider and model actually served each run.
 *
 * Two reasons this is worth persisting rather than just logging:
 *
 *  - A fallback can silently swap a cloud model for a local one, so "which backend was
 *    running when it did that?" is otherwise unanswerable after the fact.
 *  - A run parked for approval re-resolves its provider when it resumes. The transcript
 *    replays provider-native blocks, so resuming on a *different* provider is a
 *    correctness hazard — and detecting it needs the original provider on record.
 */
export function runProviderDiagnosticsMigration(db: SqlJsDatabase, fromVersion: number): void {
  if (fromVersion >= 4) return;
  db.run('BEGIN TRANSACTION');
  try {
    addColumn(db, 'agent_runs', 'provider_id', 'TEXT');
    addColumn(db, 'agent_runs', 'model_id', 'TEXT');
    addColumn(db, 'agent_runs', 'provider_reason', 'TEXT');
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

/**
 * SQLite has no ADD COLUMN IF NOT EXISTS, and a duplicate add aborts the transaction —
 * which would roll back the whole migration on a partially-upgraded database.
 */
function addColumn(db: SqlJsDatabase, table: string, column: string, type: string): void {
  const existing = db.exec(`PRAGMA table_info(${table})`);
  const columns = existing[0]?.values.map((row) => String(row[1])) ?? [];
  if (columns.includes(column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
