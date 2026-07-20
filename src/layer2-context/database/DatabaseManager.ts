// ═══════════════════════════════════════════════════════════════
// Database Manager — sql.js WASM SQLite initialization & ops
// ═══════════════════════════════════════════════════════════════

import * as path from 'path';
import * as fs from 'fs';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { Logger } from '../../shared/Logger';
import { EventBus } from '../../shared/EventBus';
import { DatabaseError } from '../../shared/errors';
import { DB_FILENAME, DB_VERSION } from '../../shared/constants';
import { runMigrations } from './migrations/001_initial';
import { runAgentMigration } from './migrations/002_agent';
import { runTranscriptMigration } from './migrations/003_agent_transcript';

/**
 * Manages the SQLite database lifecycle using sql.js (WASM).
 *
 * Key design decisions:
 * - Database file is stored in the VS Code global storage path
 *   (not workspace) so it persists across sessions.
 * - WAL mode is NOT available in sql.js (WASM limitation), but
 *   since all access is in-process and single-threaded, this is fine.
 * - Auto-saves after write operations to avoid data loss.
 */
export class DatabaseManager {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private logger = Logger.getInstance();
  private eventBus = EventBus.getInstance();
  private isDirty = false;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, DB_FILENAME);
  }

  /**
   * Initialize the database: load sql.js WASM, open or create DB,
   * and run any pending migrations.
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing database', { path: this.dbPath });

      // Locate the WASM binary relative to the extension output
      const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
      const SQL = await initSqlJs({
        locateFile: () => wasmPath,
      });

      // Load existing database or create new one
      if (fs.existsSync(this.dbPath)) {
        const fileBuffer = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(fileBuffer);
        this.logger.info('Loaded existing database');
      } else {
        // Ensure directory exists
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new SQL.Database();
        this.logger.info('Created new database');
      }

      // Enable foreign keys
      this.db.run('PRAGMA foreign_keys = ON');
      this.db.run('PRAGMA journal_mode = DELETE');

      // Run migrations
      await this.migrate();

      // Trust is intentionally never carried across an extension-host restart.
      try { this.db.run('UPDATE agent_session_trust SET trusted = 0'); this.markDirty(); } catch { /* migration may not exist yet */ }

      // Check and patch files table for 'content' column if missing
      try {
        const columns = this.query<{ name: string }>('PRAGMA table_info(files)');
        const hasContent = columns.some(col => col.name === 'content');
        if (!hasContent) {
          this.logger.info('Patching files table to add content column');
          this.db.run("ALTER TABLE files ADD COLUMN content TEXT NOT NULL DEFAULT ''");
          this.markDirty();
          this.save();
        }
      } catch (err) {
        this.logger.error('Failed to check/patch files table schema', err);
      }

      // Check and patch chat_messages table for 'content' column if missing
      try {
        const columns = this.query<{ name: string }>('PRAGMA table_info(chat_messages)');
        const hasContent = columns.some(col => col.name === 'content');
        if (!hasContent) {
          this.logger.info('Patching chat_messages table to add content column');
          this.db.run("ALTER TABLE chat_messages ADD COLUMN content TEXT NOT NULL DEFAULT ''");
          this.markDirty();
          this.save();
        }
      } catch (err) {
        this.logger.error('Failed to check/patch chat_messages table schema', err);
      }

      this.eventBus.emit('db:initialized', { path: this.dbPath });
    } catch (error) {
      throw new DatabaseError('Failed to initialize database', {
        path: this.dbPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get the raw sql.js Database instance for direct queries.
   * Throws if not initialized.
   */
  getDb(): SqlJsDatabase {
    if (!this.db) {
      throw new DatabaseError('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a SQL statement with parameters.
   * Marks the database as dirty for auto-save.
   */
  run(sql: string, params?: any[]): void {
    this.getDb().run(sql, params);
    this.markDirty();
  }

  /**
   * Execute a query and return all result rows as objects.
   */
  query<T = Record<string, any>>(sql: string, params?: any[]): T[] {
    const stmt = this.getDb().prepare(sql);
    if (params) {
      stmt.bind(params);
    }

    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  /**
   * Execute a query and return the first result row.
   */
  queryOne<T = Record<string, any>>(sql: string, params?: any[]): T | null {
    const results = this.query<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute multiple statements in a transaction.
   */
  transaction(fn: () => void): void {
    const db = this.getDb();
    db.run('BEGIN TRANSACTION');
    try {
      fn();
      db.run('COMMIT');
      this.markDirty();
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  /**
   * Persist the in-memory database to disk.
   */
  save(): void {
    if (!this.db || !this.isDirty) return;

    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);

      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.dbPath, buffer);
      this.isDirty = false;
      this.logger.debug('Database saved to disk');
    } catch (error) {
      this.logger.error('Failed to save database', error);
    }
  }

  /**
   * Close the database and flush to disk.
   */
  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.logger.info('Database closed');
  }

  /**
   * Run schema migrations.
   */
  private async migrate(): Promise<void> {
    const db = this.getDb();

    // Create migrations tracking table
    db.run(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const currentVersion = this.queryOne<{ version: number }>(
      'SELECT MAX(version) as version FROM _migrations',
    );
    const version = currentVersion?.version ?? 0;

    if (version < DB_VERSION) {
      this.logger.info('Running database migrations', { from: version, to: DB_VERSION });
      runMigrations(db, version);
      runAgentMigration(db, version);
      runTranscriptMigration(db, version);
      db.run('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', [
        DB_VERSION,
        Date.now(),
      ]);
      this.markDirty();
      this.save();
      this.eventBus.emit('db:migrated', { version: DB_VERSION });
    }
  }

  /**
   * Mark the database as dirty and schedule a debounced save.
   */
  private markDirty(): void {
    this.isDirty = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    // Auto-save after 2 seconds of inactivity
    this.saveTimer = setTimeout(() => this.save(), 2000);
  }
}
