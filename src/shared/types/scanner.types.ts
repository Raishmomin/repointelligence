// ═══════════════════════════════════════════════════════════════
// Scanner Types — File classification, framework detection
// ═══════════════════════════════════════════════════════════════

export type Language =
  | 'typescript'
  | 'typescriptreact'
  | 'javascript'
  | 'javascriptreact'
  | 'json'
  | 'css'
  | 'scss'
  | 'html'
  | 'markdown'
  | 'yaml'
  | 'unknown';

export type FileCategory =
  | 'component'
  | 'page'
  | 'layout'
  | 'hook'
  | 'context'
  | 'service'
  | 'api-route'
  | 'controller'
  | 'middleware'
  | 'utility'
  | 'helper'
  | 'lib'
  | 'type'
  | 'interface'
  | 'enum'
  | 'constant'
  | 'config'
  | 'test'
  | 'style'
  | 'store'
  | 'reducer'
  | 'action'
  | 'model'
  | 'schema'
  | 'migration'
  | 'guard'
  | 'pipe'
  | 'interceptor'
  | 'decorator'
  | 'module'
  | 'provider'
  | 'unknown';

export type Framework =
  | 'react'
  | 'nextjs'
  | 'nestjs'
  | 'express'
  | 'node'
  | 'unknown';

export type RouterType =
  | 'app-router'
  | 'pages-router'
  | 'react-router'
  | 'nest-router'
  | 'express-router'
  | 'unknown';

export interface ScannedFile {
  path: string;
  relativePath: string;
  language: Language;
  category: FileCategory;
  content: string;
  hash: string;
  size: number;
  lastModified: number;
}

export interface FrameworkInfo {
  primary: Framework;
  secondary: Framework[];
  version: string;
  router: RouterType;
  stateManagement: string[];
  styling: string[];
  testing: string[];
  orm: string | null;
}

export interface PackageInfo {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  hasWorkspaces: boolean;
  workspaces: string[];
}

export interface ScanResult {
  projectId: string;
  rootPath: string;
  files: ScannedFile[];
  framework: FrameworkInfo;
  packages: PackageInfo;
  stats: ScanStats;
  duration: number;
}

export interface ScanStats {
  totalFiles: number;
  byLanguage: Record<Language, number>;
  byCategory: Record<string, number>;
  totalSize: number;
  skippedFiles: number;
}

/**
 * Strategy interface for pluggable framework detectors.
 * Each detector checks for framework-specific markers
 * (package.json deps, directory patterns, AST patterns).
 */
export interface IFrameworkDetector {
  /** Unique identifier for this detector */
  readonly name: Framework;

  /**
   * Detect whether this framework is present in the project.
   * @param rootPath - Workspace root path
   * @param packageInfo - Parsed package.json
   * @param filePaths - All scanned file relative paths
   * @returns Detection result with confidence score
   */
  detect(
    rootPath: string,
    packageInfo: PackageInfo,
    filePaths: string[],
  ): Promise<FrameworkDetectionResult>;
}

export interface FrameworkDetectionResult {
  detected: boolean;
  framework: Framework;
  confidence: number; // 0-1
  version: string;
  evidence: string[];
  metadata: Partial<FrameworkInfo>;
}
