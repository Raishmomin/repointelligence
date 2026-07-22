// ═══════════════════════════════════════════════════════════════
// Chat Repository — sessions and messages for the chat panel
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { DatabaseManager } from '../DatabaseManager';
import { ChatMessageDto, SessionDto } from '../../../shared/types/webview.types';

/** Shown until the first message gives the session a real title. */
export const UNTITLED_SESSION = 'New Chat Session';

/** Longest session title kept from a first message before it is elided. */
const TITLE_MAX_LENGTH = 30;

interface SessionRow {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Owns every chat_sessions / chat_messages query.
 *
 * These lived inline in ChatWebviewProvider, where the session-list SELECT was repeated
 * verbatim five times and the first-message rename existed on only one of the two send
 * paths — so sessions created from the React panel kept the placeholder title forever.
 * Collecting them here means each of those behaviours has exactly one definition.
 */
export class ChatRepository {
  constructor(private db: DatabaseManager) {}

  /** Sessions for a project, most recently active first. */
  listSessions(projectId: string): SessionDto[] {
    const rows = this.db.query<SessionRow>(
      `SELECT id, title, created_at, updated_at FROM chat_sessions
       WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC`,
      [projectId],
    );

    return rows.map((row) => ({
      id: row.id,
      // The column is nullable but the protocol's title is not, so the placeholder is
      // applied here rather than leaving the webview to handle a null it cannot render.
      title: row.title ?? UNTITLED_SESSION,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createSession(projectId: string): string {
    const sessionId = uuid();
    const now = Date.now();
    this.db.run(
      'INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, projectId, UNTITLED_SESSION, now, now],
    );
    this.db.save();
    return sessionId;
  }

  deleteSession(sessionId: string): void {
    this.db.run('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]);
    this.db.run('DELETE FROM chat_sessions WHERE id = ?', [sessionId]);
    this.db.save();
  }

  listMessages(sessionId: string): ChatMessageDto[] {
    const rows = this.db.query<{ id: string; role: string; content: string; created_at: number }>(
      'SELECT id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    );

    return rows.map((row) => ({
      id: row.id,
      role: row.role as 'user' | 'assistant',
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  countMessages(sessionId: string): number {
    return (
      this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?',
        [sessionId],
      )?.count ?? 0
    );
  }

  /**
   * Appends a message and marks its session as active now.
   *
   * Touching `updated_at` is what makes it usable as a sort key. It was previously written
   * only on insert and on the first-message rename, so the session list could not order by
   * real activity.
   */
  addMessage(sessionId: string, role: 'user' | 'assistant', content: string): string {
    const id = uuid();
    const now = Date.now();

    this.db.run(
      'INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, sessionId, role, content, now],
    );
    this.db.run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', [now, sessionId]);
    this.db.save();

    return id;
  }

  /**
   * Drops everything after the session's last user message and returns that message.
   *
   * Retry re-runs a prompt rather than continuing from the reply, so the reply it is
   * replacing has to go — otherwise the transcript accumulates every rejected attempt.
   * Safe to call twice: with the trailing assistant turns already gone it simply returns
   * the same prompt again.
   *
   * @returns the prompt to re-run, or null when the session has no user message.
   */
  rewindToLastUserMessage(sessionId: string): string | null {
    const last = this.db.queryOne<{ id: string; content: string; created_at: number }>(
      `SELECT id, content, created_at FROM chat_messages
       WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [sessionId],
    );
    if (!last) return null;

    // Compared by rowid as well as timestamp: messages recorded in the same millisecond
    // would otherwise be ambiguous, and an assistant reply to a fast tool-free turn can
    // land on the same millisecond as its prompt.
    this.db.run(
      `DELETE FROM chat_messages
       WHERE session_id = ?
         AND (created_at > ? OR (created_at = ? AND rowid > (SELECT rowid FROM chat_messages WHERE id = ?)))`,
      [sessionId, last.created_at, last.created_at, last.id],
    );
    this.db.save();

    return last.content;
  }

  /**
   * Names a session after its first message.
   *
   * No-op once the session has a title of its own, so a retry or a reload cannot rename a
   * conversation the user has already been reading under another name.
   *
   * @returns whether a rename happened, so the caller knows to re-push the session list.
   */
  titleFromFirstMessage(sessionId: string, text: string): boolean {
    const row = this.db.queryOne<{ title: string | null }>(
      'SELECT title FROM chat_sessions WHERE id = ?',
      [sessionId],
    );
    if (!row || (row.title && row.title !== UNTITLED_SESSION)) return false;

    const trimmed = text.trim();
    if (!trimmed) return false;

    const title =
      trimmed.length > TITLE_MAX_LENGTH ? `${trimmed.slice(0, TITLE_MAX_LENGTH)}...` : trimmed;

    this.db.run('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?', [
      title,
      Date.now(),
      sessionId,
    ]);
    this.db.save();
    return true;
  }
}
