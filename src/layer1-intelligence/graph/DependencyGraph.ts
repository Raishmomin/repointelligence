// ═══════════════════════════════════════════════════════════════
// Dependency Graph — Adjacency list and cycle detection for codebase
// ═══════════════════════════════════════════════════════════════

import { ParsedFile, FileCluster } from '../../shared/types/ast.types';

export class DependencyGraph {
  // maps file path -> Set of imported file paths
  private dependencies = new Map<string, Set<string>>();
  // maps file path -> Set of file paths importing it
  private dependents = new Map<string, Set<string>>();

  /**
   * Build the dependency graph from parsed files.
   */
  build(parsedFiles: ParsedFile[]): void {
    this.dependencies.clear();
    this.dependents.clear();

    const fileMap = new Map<string, ParsedFile>();
    for (const file of parsedFiles) {
      fileMap.set(file.path, file);
      this.dependencies.set(file.path, new Set());
      this.dependents.set(file.path, new Set());
    }

    for (const file of parsedFiles) {
      for (const imp of file.imports) {
        if (imp.resolvedPath && fileMap.has(imp.resolvedPath)) {
          this.dependencies.get(file.path)!.add(imp.resolvedPath);

          if (!this.dependents.has(imp.resolvedPath)) {
            this.dependents.set(imp.resolvedPath, new Set());
          }
          this.dependents.get(imp.resolvedPath)!.add(file.path);
        }
      }
    }
  }

  /**
   * Get direct dependencies of a file.
   */
  getDependencies(filePath: string): string[] {
    return Array.from(this.dependencies.get(filePath) || []);
  }

  /**
   * Get direct dependents on a file.
   */
  getDependents(filePath: string): string[] {
    return Array.from(this.dependents.get(filePath) || []);
  }

  /**
   * Traverse the graph transitively to find all dependencies up to a certain depth.
   */
  getTransitiveDeps(filePath: string, depth = 3): string[] {
    const visited = new Set<string>();
    this.traverse(filePath, this.dependencies, visited, 0, depth);
    visited.delete(filePath); // Exclude the starting file itself
    return Array.from(visited);
  }

  /**
   * Traverse the graph transitively to find all dependents (affected files) up to a certain depth.
   */
  getAffectedFiles(changedFiles: string[]): string[] {
    const visited = new Set<string>();
    for (const file of changedFiles) {
      this.traverse(file, this.dependents, visited, 0, 5); // Max depth 5 for affected files
    }
    for (const file of changedFiles) {
      visited.delete(file);
    }
    return Array.from(visited);
  }

  /**
   * Group files into clusters based on shared dependencies and import density.
   */
  getClusters(): FileCluster[] {
    const clusters: FileCluster[] = [];
    const visited = new Set<string>();

    for (const file of this.dependencies.keys()) {
      if (visited.has(file)) continue;

      const clusterFiles = new Set<string>();
      this.findConnectedComponent(file, clusterFiles);

      for (const f of clusterFiles) {
        visited.add(f);
      }

      if (clusterFiles.size > 1) {
        const paths = Array.from(clusterFiles);
        const name = paths.length > 0 ? `cluster-${paths[0].split('/').pop()?.split('.')[0]}` : 'cluster';
        clusters.push({
          name,
          files: paths,
          cohesion: 1.0, // simplified cohesion calculation
          type: 'component-group',
        });
      }
    }

    return clusters;
  }

  private traverse(
    curr: string,
    map: Map<string, Set<string>>,
    visited: Set<string>,
    currentDepth: number,
    maxDepth: number
  ): void {
    if (currentDepth > maxDepth || visited.has(curr)) return;
    visited.add(curr);

    const neighbors = map.get(curr);
    if (neighbors) {
      for (const next of neighbors) {
        this.traverse(next, map, visited, currentDepth + 1, maxDepth);
      }
    }
  }

  private findConnectedComponent(node: string, component: Set<string>): void {
    const queue: string[] = [node];
    component.add(node);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const neighbors = new Set([
        ...(this.dependencies.get(curr) || []),
        ...(this.dependents.get(curr) || [])
      ]);

      for (const next of neighbors) {
        if (!component.has(next)) {
          component.add(next);
          queue.push(next);
        }
      }
    }
  }
}
