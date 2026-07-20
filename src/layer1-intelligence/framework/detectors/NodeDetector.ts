// ═══════════════════════════════════════════════════════════════
// Node.js Detector — Fallback for plain Node.js projects
// ═══════════════════════════════════════════════════════════════

import { IFrameworkDetector, FrameworkDetectionResult, PackageInfo } from '../../../shared/types/scanner.types';

export class NodeDetector implements IFrameworkDetector {
  readonly name = 'node' as const;

  async detect(_rootPath: string, pkg: PackageInfo, filePaths: string[]): Promise<FrameworkDetectionResult> {
    const evidence: string[] = [];
    let confidence = 0;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // If package.json exists, it's at least a Node project
    if (pkg.name) {
      evidence.push('package.json found');
      confidence += 0.3;
    }

    // Check for Node-specific deps
    if (allDeps['typescript'] || allDeps['ts-node']) { evidence.push('TypeScript project'); confidence += 0.2; }

    const tsFiles = filePaths.filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    if (tsFiles.length > 0) { evidence.push(`${tsFiles.length} TS/JS files`); confidence += 0.2; }

    // If scripts reference node
    const scripts = Object.values(pkg.scripts).join(' ');
    if (scripts.includes('node ') || scripts.includes('ts-node') || scripts.includes('tsx ')) {
      evidence.push('Node scripts detected');
      confidence += 0.1;
    }

    return {
      detected: confidence >= 0.3,
      framework: 'node',
      confidence: Math.min(confidence, 1),
      version: process.version,
      evidence,
      metadata: {},
    };
  }
}
