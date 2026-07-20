// ═══════════════════════════════════════════════════════════════
// Convention Detector — Automatically infer team coding conventions
// ═══════════════════════════════════════════════════════════════

import { ParsedFile } from '../../shared/types/ast.types';
import { ProjectConvention } from '../../shared/types/context.types';

export class ConventionDetector {
  /**
   * Infer coding conventions from the parsed codebase files.
   */
  detect(parsedFiles: ParsedFile[]): ProjectConvention[] {
    const conventions: ProjectConvention[] = [];

    if (parsedFiles.length === 0) return conventions;

    // 1. Export Style: Default vs Named Exports
    let defaultCount = 0;
    let namedCount = 0;
    for (const file of parsedFiles) {
      for (const exp of file.exports) {
        if (exp.isDefault) defaultCount++;
        else namedCount++;
      }
    }

    if (namedCount > defaultCount * 2) {
      conventions.push({
        category: 'exports',
        rule: 'Prefer named exports over default exports for code consistency and easier refactoring.',
        examples: ['export const MyComponent = ...', 'export function helper() ...'],
        confidence: 0.85,
      });
    } else if (defaultCount > namedCount * 1.5) {
      conventions.push({
        category: 'exports',
        rule: 'Prefer default exports for main file declarations (components, routes).',
        examples: ['export default MyComponent;'],
        confidence: 0.8,
      });
    }

    // 2. React Naming Style: PascalCase components vs camelCase/kebab-case directories
    const componentFiles = parsedFiles.filter(f => f.relativePath.includes('components/'));
    if (componentFiles.length > 0) {
      let pascalFiles = 0;
      let kebabFiles = 0;

      for (const file of componentFiles) {
        const baseName = file.relativePath.split('/').pop()?.split('.')[0] || '';
        if (/^[A-Z][a-zA-Z0-9]*$/.test(baseName)) {
          pascalFiles++;
        } else if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(baseName)) {
          kebabFiles++;
        }
      }

      if (pascalFiles > kebabFiles * 2) {
        conventions.push({
          category: 'naming',
          rule: 'React components should be defined in PascalCase files.',
          examples: ['Button.tsx', 'UserProfile.tsx'],
          confidence: 0.9,
        });
      } else if (kebabFiles > pascalFiles * 2) {
        conventions.push({
          category: 'naming',
          rule: 'React component files should use kebab-case file names.',
          examples: ['button.tsx', 'user-profile.tsx'],
          confidence: 0.9,
        });
      }
    }

    // 3. Import Style: Absolute path aliases vs Relative paths
    let relativeImports = 0;
    let aliasImports = 0;
    for (const file of parsedFiles) {
      for (const imp of file.imports) {
        if (!imp.isExternal) {
          if (imp.source.startsWith('.')) {
            relativeImports++;
          } else if (imp.source.startsWith('@/') || imp.source.startsWith('~/') || imp.source.startsWith('@components')) {
            aliasImports++;
          }
        }
      }
    }

    if (aliasImports > relativeImports) {
      conventions.push({
        category: 'imports',
        rule: 'Use absolute path aliases (e.g. "@/...") rather than relative pathing (e.g. "../../../").',
        examples: ["import { Button } from '@/components/Button'"],
        confidence: 0.85,
      });
    } else {
      conventions.push({
        category: 'imports',
        rule: 'Use relative pathing for local file import structures.',
        examples: ["import { helper } from '../utils/helper'"],
        confidence: 0.8,
      });
    }

    return conventions;
  }
}
