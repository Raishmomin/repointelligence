import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { ChatRepository, UNTITLED_SESSION } from '../../src/layer2-context/database/repositories/ChatRepository';
import { DatabaseManager } from '../../src/layer2-context/database/DatabaseManager';

/** Real in-memory SQLite: the rewind logic is SQL, and a fake would test the fake. */
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let repo: ChatRepository;
let manager: DatabaseManager;

const PROJECT = 'p1';

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  const db: SqlJsDatabase = new SQL.Database();
  db.run(`CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);

  manager = new DatabaseManager('/unused');
  (manager as unknown as { db: SqlJsDatabase }).db = db;
  // save() writes to disk; the tests only care about state inside the in-memory handle.
  (manager as unknown as { save(): void }).save = () => {};
  repo = new ChatRepository(manager);
});

describe('rewindToLastUserMessage', () => {
  it('returns the last prompt and removes the reply that followed it', () => {
    const session = repo.createSession(PROJECT);
    repo.addMessage(session, 'user', 'find the footer');
    repo.addMessage(session, 'assistant', 'I could not find it');

    const prompt = repo.rewindToLastUserMessage(session);

    expect(prompt).toBe('find the footer');
    expect(repo.listMessages(session).map((m) => m.role)).toEqual(['user']);
  });

  it('drops a same-millisecond reply', () => {
    // addMessage stamps Date.now(); a reply to a fast tool-free turn can land in the same
    // millisecond as its prompt, where a timestamp-only comparison cannot see it.
    const session = repo.createSession(PROJECT);
    manager.run(
      "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES ('m1', ?, 'user', 'q', 1000)",
      [session],
    );
    manager.run(
      "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES ('m2', ?, 'assistant', 'a', 1000)",
      [session],
    );

    expect(repo.rewindToLastUserMessage(session)).toBe('q');
    expect(repo.listMessages(session)).toHaveLength(1);
  });

  it('keeps earlier exchanges intact', () => {
    const session = repo.createSession(PROJECT);
    repo.addMessage(session, 'user', 'first question');
    repo.addMessage(session, 'assistant', 'first answer');
    repo.addMessage(session, 'user', 'second question');
    repo.addMessage(session, 'assistant', 'second answer');

    const prompt = repo.rewindToLastUserMessage(session);

    expect(prompt).toBe('second question');
    expect(repo.listMessages(session).map((m) => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
    ]);
  });

  it('is safe to call twice', () => {
    // Two rapid retry clicks must not eat the prompt itself.
    const session = repo.createSession(PROJECT);
    repo.addMessage(session, 'user', 'only question');
    repo.addMessage(session, 'assistant', 'reply');

    expect(repo.rewindToLastUserMessage(session)).toBe('only question');
    expect(repo.rewindToLastUserMessage(session)).toBe('only question');
    expect(repo.listMessages(session)).toHaveLength(1);
  });

  it('returns null for a session with no user message', () => {
    const session = repo.createSession(PROJECT);
    expect(repo.rewindToLastUserMessage(session)).toBeNull();
  });
});

describe('titleFromFirstMessage', () => {
  it('names an untitled session and reports the rename', () => {
    const session = repo.createSession(PROJECT);
    expect(repo.titleFromFirstMessage(session, 'modify the footer design')).toBe(true);
    expect(repo.listSessions(PROJECT)[0].title).toBe('modify the footer design');
  });

  it('does not rename a session that already has a real title', () => {
    // A retry or reload re-records a user message; that must not retitle a conversation
    // the user has been reading under another name.
    const session = repo.createSession(PROJECT);
    repo.titleFromFirstMessage(session, 'original topic');

    expect(repo.titleFromFirstMessage(session, 'different text')).toBe(false);
    expect(repo.listSessions(PROJECT)[0].title).toBe('original topic');
  });

  it('elides a long prompt', () => {
    const session = repo.createSession(PROJECT);
    repo.titleFromFirstMessage(session, 'x'.repeat(100));

    const title = repo.listSessions(PROJECT)[0].title;
    expect(title.length).toBeLessThanOrEqual(33);
    expect(title.endsWith('...')).toBe(true);
  });

  it('keeps the placeholder for a blank message', () => {
    const session = repo.createSession(PROJECT);
    expect(repo.titleFromFirstMessage(session, '   ')).toBe(false);
    expect(repo.listSessions(PROJECT)[0].title).toBe(UNTITLED_SESSION);
  });
});

describe('listSessions', () => {
  it('orders by last activity, not creation', () => {
    // Timestamps written directly: two sessions created in one test run share a
    // millisecond, which would make the ordering a coin toss.
    const older = repo.createSession(PROJECT);
    const newer = repo.createSession(PROJECT);
    manager.run('UPDATE chat_sessions SET created_at = 1000, updated_at = 5000 WHERE id = ?', [older]);
    manager.run('UPDATE chat_sessions SET created_at = 2000, updated_at = 3000 WHERE id = ?', [newer]);

    // The older session saw activity more recently, so it leads.
    expect(repo.listSessions(PROJECT).map((s) => s.id)).toEqual([older, newer]);
  });
});
