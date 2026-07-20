// ═══════════════════════════════════════════════════════════════
// Pattern Detector — Detect design patterns & conventions in code
// ═══════════════════════════════════════════════════════════════

import { SourceFile } from 'ts-morph';
import { DetectedPattern, SymbolInfo } from '../../shared/types/ast.types';

export class PatternDetector {
  /**
   * Detect patterns in a source file based on its AST structure and symbol information.
   */
  detect(sourceFile: SourceFile, symbols: SymbolInfo[]): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const fileName = sourceFile.getBaseName().toLowerCase();

    // 1. Hook / React Hook Pattern
    const hasHookName = symbols.some(s => s.kind === 'hook' || s.name.startsWith('use'));
    if (hasHookName) {
      const hookSymbol = symbols.find(s => s.name.startsWith('use'));
      patterns.push({
        type: 'custom-hook',
        symbolName: hookSymbol?.name ?? 'useHook',
        confidence: 0.9,
        evidence: `Custom hook detected matching 'use*' prefix format.`,
      });
    }

    // 2. Context Provider Pattern
    if (fileName.includes('context') || fileName.includes('provider')) {
      const providerSymbol = symbols.find(s => s.name.endsWith('Provider') || s.name.endsWith('Context'));
      if (providerSymbol) {
        patterns.push({
          type: 'context-provider',
          symbolName: providerSymbol.name,
          confidence: 0.85,
          evidence: `Context or Provider naming/semantics found in file metadata.`,
        });
      }
    }

    // 3. Singleton Pattern
    for (const sym of symbols) {
      if (sym.kind === 'class') {
        const metadata = sym.metadata as any;
        const properties = metadata?.properties || [];
        const methods = metadata?.methods || [];

        // Singleton if has static instance property & private constructor or static getInstance method
        const hasStaticInstance = properties.some((p: any) => p.name === 'instance' && p.type.includes(sym.name));
        const hasGetInstance = methods.some((m: any) => m.name === 'getInstance');

        if (hasStaticInstance || hasGetInstance) {
          patterns.push({
            type: 'singleton',
            symbolName: sym.name,
            confidence: 0.95,
            evidence: `Class "${sym.name}" contains static instance or getInstance helper structure.`,
          });
        }
      }
    }

    // 4. Factory Pattern
    for (const sym of symbols) {
      if (sym.name.startsWith('create') || sym.name.endsWith('Factory')) {
        patterns.push({
          type: 'factory',
          symbolName: sym.name,
          confidence: 0.75,
          evidence: `Method/function "${sym.name}" matches factory instantiation naming convention.`,
        });
      }
    }

    // 5. NestJS Repository / Service Pattern
    for (const sym of symbols) {
      if (sym.kind === 'class') {
        const decorators = sym.decorators;
        if (decorators.includes('Injectable') || decorators.includes('Controller') || decorators.includes('Module')) {
          patterns.push({
            type: 'dependency-injection',
            symbolName: sym.name,
            confidence: 0.9,
            evidence: `Class "${sym.name}" annotated with dependency injection decorators: ${decorators.join(', ')}`,
          });
        }
      }
    }

    // 6. Barrel Export Pattern
    const isBarrel = sourceFile.getExportDeclarations().length > 0 &&
                     sourceFile.getClasses().length === 0 &&
                     sourceFile.getFunctions().length === 0 &&
                     sourceFile.getVariableStatements().length === 0;
    if (isBarrel) {
      patterns.push({
        type: 'barrel-export',
        symbolName: 'index',
        confidence: 0.9,
        evidence: `File only exports other files/modules with no inner implementations.`,
      });
    }

    return patterns;
  }
}
