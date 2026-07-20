// ═══════════════════════════════════════════════════════════════
// NestJS Detector
// ═══════════════════════════════════════════════════════════════

import { IFrameworkDetector, FrameworkDetectionResult, PackageInfo } from '../../../shared/types/scanner.types';

export class NestjsDetector implements IFrameworkDetector {
  readonly name = 'nestjs' as const;

  async detect(_rootPath: string, pkg: PackageInfo, filePaths: string[]): Promise<FrameworkDetectionResult> {
    const evidence: string[] = [];
    let confidence = 0;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps['@nestjs/core']) {
      evidence.push(`@nestjs/core@${allDeps['@nestjs/core']} found`);
      confidence += 0.6;
    }
    if (allDeps['@nestjs/common']) {
      evidence.push('@nestjs/common found');
      confidence += 0.2;
    }

    // NestJS naming conventions
    const controllers = filePaths.filter(f => f.includes('.controller.'));
    const modules = filePaths.filter(f => f.includes('.module.'));
    const services = filePaths.filter(f => f.includes('.service.'));
    if (controllers.length > 0) { evidence.push(`${controllers.length} controllers`); confidence += 0.1; }
    if (modules.length > 0) { evidence.push(`${modules.length} modules`); confidence += 0.05; }
    if (services.length > 0) { evidence.push(`${services.length} services`); confidence += 0.05; }

    // Detect ORM
    let orm: string | null = null;
    if (allDeps['@nestjs/typeorm'] || allDeps['typeorm']) orm = 'typeorm';
    else if (allDeps['@nestjs/mongoose'] || allDeps['mongoose']) orm = 'mongoose';
    else if (allDeps['@prisma/client']) orm = 'prisma';
    else if (allDeps['drizzle-orm']) orm = 'drizzle';

    return {
      detected: confidence >= 0.5,
      framework: 'nestjs',
      confidence: Math.min(confidence, 1),
      version: allDeps['@nestjs/core'] ?? '',
      evidence,
      metadata: { router: 'nest-router' as const, orm },
    };
  }
}
