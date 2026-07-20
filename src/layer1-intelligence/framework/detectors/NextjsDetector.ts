// ═══════════════════════════════════════════════════════════════
// Next.js Detector
// ═══════════════════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';
import { IFrameworkDetector, FrameworkDetectionResult, PackageInfo } from '../../../shared/types/scanner.types';

export class NextjsDetector implements IFrameworkDetector {
  readonly name = 'nextjs' as const;

  async detect(rootPath: string, pkg: PackageInfo, filePaths: string[]): Promise<FrameworkDetectionResult> {
    const evidence: string[] = [];
    let confidence = 0;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps['next']) {
      evidence.push(`next@${allDeps['next']} in dependencies`);
      confidence += 0.6;
    }

    // Detect App Router vs Pages Router
    const hasAppDir = filePaths.some(f => f.startsWith('app/') || f.includes('/app/'));
    const hasPagesDir = filePaths.some(f => f.startsWith('pages/') || f.includes('/pages/'));
    const hasSrcApp = filePaths.some(f => f.startsWith('src/app/'));
    const hasSrcPages = filePaths.some(f => f.startsWith('src/pages/'));

    let router: 'app-router' | 'pages-router' | 'unknown' = 'unknown';
    if (hasAppDir || hasSrcApp) {
      router = 'app-router';
      evidence.push('App Router detected (app/ directory)');
      confidence += 0.2;
    } else if (hasPagesDir || hasSrcPages) {
      router = 'pages-router';
      evidence.push('Pages Router detected (pages/ directory)');
      confidence += 0.2;
    }

    // Check for next.config
    const configFiles = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
    for (const cfg of configFiles) {
      if (fs.existsSync(path.join(rootPath, cfg))) {
        evidence.push(`${cfg} found`);
        confidence += 0.1;
        break;
      }
    }

    // Detect ORM
    let orm: string | null = null;
    if (allDeps['prisma'] || allDeps['@prisma/client']) orm = 'prisma';
    else if (allDeps['drizzle-orm']) orm = 'drizzle';
    else if (allDeps['typeorm']) orm = 'typeorm';
    else if (allDeps['sequelize']) orm = 'sequelize';

    return {
      detected: confidence >= 0.5,
      framework: 'nextjs',
      confidence: Math.min(confidence, 1),
      version: allDeps['next'] ?? '',
      evidence,
      metadata: { router, orm },
    };
  }
}
