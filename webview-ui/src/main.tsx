/**
 * Entry point. Deliberately minimal until the packaging path is proven — the plan is to
 * verify `vsce ls` ships the bundle before any component work.
 */
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<div className="boot">Repo Intelligence UI</div>);
}
