// ═══════════════════════════════════════════════════════════════
// Framework Detector — Orchestrator using Strategy pattern
// ═══════════════════════════════════════════════════════════════

import { Logger } from '../../shared/Logger';
import { IFrameworkDetector, FrameworkDetectionResult, FrameworkInfo, PackageInfo, Framework } from '../../shared/types/scanner.types';
import { ReactDetector } from './detectors/ReactDetector';
import { NextjsDetector } from './detectors/NextjsDetector';
import { NestjsDetector } from './detectors/NestjsDetector';
import { ExpressDetector } from './detectors/ExpressDetector';
import { NodeDetector } from './detectors/NodeDetector';

/**
 * Orchestrates all framework detectors and merges results into
 * a single FrameworkInfo object. Uses the Strategy pattern —
 * new detectors just implement IFrameworkDetector and register here.
 */
export class FrameworkDetector {
  private detectors: IFrameworkDetector[] = [];
  private logger = Logger.getInstance();

  constructor() {
    // Order matters: more specific frameworks first
    this.detectors = [
      new NextjsDetector(),  // Must be before React (Next.js includes React)
      new NestjsDetector(),
      new ExpressDetector(),
      new ReactDetector(),
      new NodeDetector(),    // Fallback
    ];
  }

  /** Register a custom detector (for future plugin support). */
  registerDetector(detector: IFrameworkDetector): void {
    this.detectors.push(detector);
  }

  /**
   * Run all detectors and merge results.
   * The highest-confidence detector becomes the primary framework.
   */
  async detect(rootPath: string, packageInfo: PackageInfo, filePaths: string[]): Promise<FrameworkInfo> {
    const results: FrameworkDetectionResult[] = [];

    for (const detector of this.detectors) {
      try {
        const result = await detector.detect(rootPath, packageInfo, filePaths);
        if (result.detected) {
          results.push(result);
          this.logger.debug(`Framework detected: ${result.framework}`, {
            confidence: result.confidence, evidence: result.evidence,
          });
        }
      } catch (error) {
        this.logger.warn(`Detector ${detector.name} failed`, { error: String(error) });
      }
    }

    if (results.length === 0) {
      return this.defaultFrameworkInfo();
    }

    // Sort by confidence, highest first
    results.sort((a, b) => b.confidence - a.confidence);
    const primary = results[0];
    const secondary = results.slice(1).map(r => r.framework);

    // Merge metadata from all detected frameworks
    const merged = this.mergeMetadata(results);

    return {
      primary: primary.framework,
      secondary,
      version: primary.version,
      router: (merged.router as FrameworkInfo['router']) ?? 'unknown',
      stateManagement: merged.stateManagement ?? [],
      styling: merged.styling ?? [],
      testing: merged.testing ?? [],
      orm: merged.orm ?? null,
    };
  }

  private mergeMetadata(results: FrameworkDetectionResult[]): Record<string, any> {
    const merged: Record<string, any> = {};
    for (const result of results) {
      for (const [key, value] of Object.entries(result.metadata)) {
        if (Array.isArray(value)) {
          merged[key] = [...new Set([...(merged[key] ?? []), ...value])];
        } else if (value !== null && value !== undefined && !merged[key]) {
          merged[key] = value;
        }
      }
    }
    return merged;
  }

  private defaultFrameworkInfo(): FrameworkInfo {
    return {
      primary: 'unknown', secondary: [], version: '',
      router: 'unknown', stateManagement: [], styling: [],
      testing: [], orm: null,
    };
  }
}
