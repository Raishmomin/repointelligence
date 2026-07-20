import * as path from 'path';

/**
 * Resolves an agent-supplied path against the workspace root, rejecting anything the
 * agent must not reach. Pure and dependency-free so the containment rules can be unit
 * tested directly — this is the boundary that keeps a model from reading `~/.ssh` or
 * writing outside the project, so it is worth testing in isolation.
 *
 * @param root             Absolute path of the workspace folder.
 * @param relativePath     Agent-supplied path; must be relative to `root`.
 * @param ignorePatterns   Path segments the agent may never traverse (e.g. `.env`).
 * @returns The resolved absolute path.
 * @throws If the path is absolute, empty, escapes the root, or hits an ignored segment.
 */
export function resolveAgentPath(root: string, relativePath: string, ignorePatterns: readonly string[] = []): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Agent paths must be relative to the selected workspace.');
  }

  const resolved = path.resolve(root, relativePath);
  // `startsWith(root + sep)` rather than `startsWith(root)` so that a sibling directory
  // sharing the root as a string prefix (`/repo-evil` against root `/repo`) is rejected.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path escapes the selected workspace.');
  }

  // Check the segments of the resolved path, not the raw input: `a/../.env` and `.env`
  // must both be caught. Split on both separators so a Windows-style path cannot slip by.
  const relative = path.relative(root, resolved);
  if (segmentsOf(relative).some((segment) => ignorePatterns.includes(segment))) {
    throw new Error('Path is excluded by agent.ignorePatterns.');
  }

  return resolved;
}

function segmentsOf(value: string): string[] {
  return value.split(/[/\\]/).filter(Boolean);
}
