import type { Database as SqlJsDatabase } from 'sql.js';

export function runAgentMigration(db: SqlJsDatabase, fromVersion: number): void {
  if (fromVersion >= 2) return;
  db.run('BEGIN TRANSACTION');
  try {
    db.run(`CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, workspace_uri TEXT NOT NULL, session_id TEXT, mode TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS change_sets (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, workspace_uri TEXT NOT NULL, summary TEXT NOT NULL, operations_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, applied_at INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS command_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, workspace_uri TEXT NOT NULL, command TEXT NOT NULL, args_json TEXT NOT NULL, cwd TEXT NOT NULL, reason TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL, output TEXT, exit_code INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS agent_approvals (id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, approved INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    // This table records trust state for the current extension host only; activation clears it.
    db.run(`CREATE TABLE IF NOT EXISTS agent_session_trust (workspace_uri TEXT PRIMARY KEY, trusted INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.run('CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs(workspace_uri)');
    db.run('CREATE INDEX IF NOT EXISTS idx_change_sets_run ON change_sets(run_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_command_requests_run ON command_requests(run_id)');
    db.run('COMMIT');
  } catch (error) { db.run('ROLLBACK'); throw error; }
}
