import type { ReactNode } from 'react';

/**
 * Full-height panel chrome for anything that swaps in over the timeline.
 *
 * Extracted from ProviderPanel once sessions needed the same header. Both are full-screen
 * swaps rather than overlays, so the header has to carry its own close affordance — there
 * is nothing visible behind it to click away to.
 */
export function Panel({
  title,
  onClose,
  onBack,
  children,
}: {
  title: string;
  onClose(): void;
  onBack?(): void;
  children: ReactNode;
}) {
  return (
    <div className="panel">
      <header className="panel-header">
        {onBack && (
          <button type="button" className="btn btn-small" onClick={onBack}>
            ←
          </button>
        )}
        <h2 className="panel-title">{title}</h2>
        <button type="button" className="btn btn-small" onClick={onClose} title="Close">
          ✕
        </button>
      </header>
      <div className="panel-body">{children}</div>
    </div>
  );
}
