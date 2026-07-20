// ═══════════════════════════════════════════════════════════════
// React Detector — Detect React framework presence
// ═══════════════════════════════════════════════════════════════

import { IFrameworkDetector, FrameworkDetectionResult, PackageInfo } from '../../../shared/types/scanner.types';

export class ReactDetector implements IFrameworkDetector {
  readonly name = 'react' as const;

  async detect(rootPath: string, pkg: PackageInfo, filePaths: string[]): Promise<FrameworkDetectionResult> {
    const evidence: string[] = [];
    let confidence = 0;

    // Check dependencies
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps['react']) {
      evidence.push(`react@${allDeps['react']} in dependencies`);
      confidence += 0.5;
    }
    if (allDeps['react-dom']) {
      evidence.push('react-dom found');
      confidence += 0.2;
    }

    // Check for JSX/TSX files
    const jsxFiles = filePaths.filter(f => f.endsWith('.tsx') || f.endsWith('.jsx'));
    if (jsxFiles.length > 0) {
      evidence.push(`${jsxFiles.length} JSX/TSX files found`);
      confidence += 0.2;
    }

    // Detect state management
    const stateManagement: string[] = [];
    if (allDeps['redux'] || allDeps['@reduxjs/toolkit']) stateManagement.push('redux');
    if (allDeps['zustand']) stateManagement.push('zustand');
    if (allDeps['recoil']) stateManagement.push('recoil');
    if (allDeps['jotai']) stateManagement.push('jotai');
    if (allDeps['mobx']) stateManagement.push('mobx');
    if (allDeps['@tanstack/react-query'] || allDeps['react-query']) stateManagement.push('react-query');

    // Detect styling
    const styling: string[] = [];
    if (allDeps['tailwindcss']) styling.push('tailwindcss');
    if (allDeps['styled-components']) styling.push('styled-components');
    if (allDeps['@emotion/react'] || allDeps['@emotion/styled']) styling.push('emotion');
    if (allDeps['@mui/material']) styling.push('material-ui');
    if (allDeps['@chakra-ui/react']) styling.push('chakra-ui');
    if (allDeps['@mantine/core']) styling.push('mantine');
    if (filePaths.some(f => f.endsWith('.module.css') || f.endsWith('.module.scss'))) styling.push('css-modules');

    // Detect testing
    const testing: string[] = [];
    if (allDeps['@testing-library/react']) testing.push('testing-library');
    if (allDeps['jest']) testing.push('jest');
    if (allDeps['vitest']) testing.push('vitest');
    if (allDeps['cypress']) testing.push('cypress');
    if (allDeps['playwright'] || allDeps['@playwright/test']) testing.push('playwright');

    // Detect router
    let router: 'react-router' | 'unknown' = 'unknown';
    if (allDeps['react-router-dom'] || allDeps['react-router']) router = 'react-router';

    return {
      detected: confidence >= 0.5,
      framework: 'react',
      confidence: Math.min(confidence, 1),
      version: allDeps['react'] ?? '',
      evidence,
      metadata: { stateManagement, styling, testing, router },
    };
  }
}
