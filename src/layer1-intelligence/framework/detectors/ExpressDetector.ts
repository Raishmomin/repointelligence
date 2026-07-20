// ═══════════════════════════════════════════════════════════════
// Express Detector
// ═══════════════════════════════════════════════════════════════

import { IFrameworkDetector, FrameworkDetectionResult, PackageInfo } from '../../../shared/types/scanner.types';

export class ExpressDetector implements IFrameworkDetector {
  readonly name = 'express' as const;

  async detect(_rootPath: string, pkg: PackageInfo, filePaths: string[]): Promise<FrameworkDetectionResult> {
    const evidence: string[] = [];
    let confidence = 0;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps['express']) {
      evidence.push(`express@${allDeps['express']} found`);
      confidence += 0.6;
    }
    if (allDeps['@types/express']) {
      evidence.push('@types/express found');
      confidence += 0.1;
    }

    const routeFiles = filePaths.filter(f => f.includes('route') || f.includes('router'));
    if (routeFiles.length > 0) { evidence.push(`${routeFiles.length} route files`); confidence += 0.1; }

    const middlewareFiles = filePaths.filter(f => f.includes('middleware'));
    if (middlewareFiles.length > 0) { evidence.push(`${middlewareFiles.length} middleware files`); confidence += 0.1; }

    return {
      detected: confidence >= 0.5,
      framework: 'express',
      confidence: Math.min(confidence, 1),
      version: allDeps['express'] ?? '',
      evidence,
      metadata: { router: 'express-router' as const },
    };
  }
}
