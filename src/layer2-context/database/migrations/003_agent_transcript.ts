import type { Database as SqlJsDatabase } from 'sql.js';

/**
 * Adds the state an agent run needs to survive being parked for approval.
 *
 * A run stops mid-turn whenever it proposes a write, and the user may not decide for
 * minutes — or until after a window reload. Resuming correctly requires the exact
 * transcript, plus enough bookkeeping to answer every `tool_use` block from the parked
 * turn with a matching `tool_result`. Losing either produces an unanswered tool call,
 * which the API rejects.
 */
export function runTranscriptMigration(db: SqlJsDatabase, fromVersion: number): void {
  if (fromVersion >= 3) return;
  db.run('BEGIN TRANSACTION');
  try {
    // Provider-native transcript, replayed verbatim so thinking blocks and compaction
    // state survive a park/resume cycle.
    addColumn(db, 'agent_runs', 'transcript_json', 'TEXT');
    // Which tool calls from the parked turn are resolved and which are still awaiting a
    // decision. Without this the resumed turn cannot be reassembled in the right order.
    addColumn(db, 'agent_runs', 'pending_turn_json', 'TEXT');
    addColumn(db, 'agent_runs', 'turn_count', 'INTEGER');

    // Ties an approval subject back to the tool call that produced it, so approving or
    // rejecting it emits a tool_result carrying the correct tool_use_id.
    addColumn(db, 'change_sets', 'tool_use_id', 'TEXT');
    addColumn(db, 'command_requests', 'tool_use_id', 'TEXT');

    // Git checkpoint captured before the change set is applied (Phase 7); revert prefers
    // it over the per-operation content snapshot when present.
    addColumn(db, 'change_sets', 'checkpoint_ref', 'TEXT');

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
