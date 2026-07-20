// ═══════════════════════════════════════════════════════════════
// Migration 001 — Initial Schema
// ═══════════════════════════════════════════════════════════════

import type { Database as SqlJsDatabase } from 'sql.js';

/**
 * Creates the full initial schema for the Repository Intelligence Engine.
 * All tables, indexes, and constraints for v1.
 */
export function runMigrations(db: SqlJsDatabase, fromVersion: number): void {
  if (fromVersion >= 1) return;

  db.run('BEGIN TRANSACTION');

  try {
    // ── Projects ────────────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        root_path   TEXT NOT NULL UNIQUE,
        framework   TEXT NOT NULL DEFAULT 'unknown',
        metadata    TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        last_scan   INTEGER
      )
    `);

    // ── Files ───────────────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS files (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path          TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        language      TEXT NOT NULL,
        category      TEXT NOT NULL,
        content       TEXT NOT NULL DEFAULT '',
        content_hash  TEXT NOT NULL,
        size          INTEGER NOT NULL,
        last_modified INTEGER NOT NULL,
        last_indexed  INTEGER,
        UNIQUE(project_id, path)
      )
    `);

    // ── Symbols ─────────────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS symbols (
        id              TEXT PRIMARY KEY,
        file_id         TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        signature       TEXT,
        documentation   TEXT,
        start_line      INTEGER NOT NULL,
        end_line        INTEGER NOT NULL,
        start_col       INTEGER,
        end_col         INTEGER,
        complexity      INTEGER DEFAULT 0,
        metadata        TEXT
      )
    `);

    // ── Dependencies ────────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS dependencies (
        id              TEXT PRIMARY KEY,
        source_file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        target_file_id  TEXT REFERENCES files(id) ON DELETE SET NULL,
        source_symbol   TEXT,
        target_symbol   TEXT,
        dep_type        TEXT NOT NULL,
        is_external     INTEGER NOT NULL DEFAULT 0,
        module_name     TEXT
      )
    `);

    // ── Embeddings ──────────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id          TEXT PRIMARY KEY,
        file_id     TEXT REFERENCES files(id) ON DELETE CASCADE,
        symbol_id   TEXT REFERENCES symbols(id) ON DELETE CASCADE,
        chunk_text  TEXT NOT NULL,
        chunk_type  TEXT NOT NULL,
        vector      BLOB NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `);

    // ── Patterns ────────────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS patterns (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        pattern     TEXT NOT NULL,
        file_id     TEXT REFERENCES files(id) ON DELETE CASCADE,
        symbol_name TEXT,
        confidence  REAL NOT NULL,
        metadata    TEXT
      )
    `);

    // ── Conventions ─────────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS conventions (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        category    TEXT NOT NULL,
        rule        TEXT NOT NULL,
        examples    TEXT,
        confidence  REAL NOT NULL
      )
    `);

    // ── Chat Sessions ───────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      )
    `);

    // ── Chat Messages ───────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        context_summary TEXT,
        model           TEXT,
        tokens_used     INTEGER,
        created_at      INTEGER NOT NULL
      )
    `);

    // ── Indexes ─────────────────────────────────────────────
    db.run('CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_category ON files(category)');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash)');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_language ON files(language)');
    db.run('CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind)');
    db.run('CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)');
    db.run('CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_file_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_file_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_deps_external ON dependencies(is_external)');
    db.run('CREATE INDEX IF NOT EXISTS idx_embeddings_file ON embeddings(file_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_embeddings_symbol ON embeddings(symbol_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_patterns_project ON patterns(project_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_conventions_project ON conventions(project_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON chat_sessions(project_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)');

    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}
