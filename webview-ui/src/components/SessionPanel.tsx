import type { SessionDto } from '@shared/webview.types';
import { Panel } from './Panel';

/**
 * Lists past conversations and starts new ones.
 *
 * Takes sessions as props rather than fetching them: the host pushes the full list on
 * every change (`sessions`), so the reducer already holds current data and an RPC round
 * trip here would only be able to return something staler.
 */
export function SessionPanel({
  sessions,
  activeSessionId,
  onClose,
  onNew,
  onSelect,
  onDelete,
}: {
  sessions: SessionDto[];
  activeSessionId: string | null;
  onClose(): void;
  onNew(): void;
  onSelect(sessionId: string): void;
  onDelete(sessionId: string): void;
}) {
  return (
    <Panel title="Chats" onClose={onClose}>
      <button
        type="button"
        className="btn btn-primary session-new"
        onClick={() => {
          onNew();
          // The panel's job is done once a new chat exists; staying open would hide the
          // conversation the user just asked for.
          onClose();
        }}
      >
        + New Chat
      </button>

      {sessions.length === 0 ? (
        <p className="panel-hint">No chats yet.</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li
              key={session.id}
              className={`session-row${session.id === activeSessionId ? ' session-row-active' : ''}`}
            >
              <button
                type="button"
                className="session-open"
                onClick={() => {
                  onSelect(session.id);
                  onClose();
                }}
              >
                <span className="session-title">{session.title}</span>
                <span className="session-when">{relativeTime(session.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="btn btn-small session-delete"
                title="Delete chat"
                onClick={() => onDelete(session.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Coarse relative time — "5m", "3h", "2d".
 *
 * Deliberately not a locale-formatted timestamp: the sidebar is narrow, and the only
 * question this answers is which conversation was the recent one.
 */
function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(epochMs).toLocaleDateString();
}
