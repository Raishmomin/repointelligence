// ═══════════════════════════════════════════════════════════════
// Import Resolver — Resolve file imports semantically
// ═══════════════════════════════════════════════════════════════

import { SourceFile, SyntaxKind } from 'ts-morph';
import { ImportInfo } from '../../shared/types/ast.types';

export class ImportResolver {
  /**
   * Resolve all imports in a source file.
   */
  resolve(sourceFile: SourceFile): ImportInfo[] {
    const imports: ImportInfo[] = [];

    // Static imports (import ... from '...')
    for (const imp of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = imp.getModuleSpecifierValue();
      const specifiers: string[] = [];

      const defaultImport = imp.getDefaultImport();
      if (defaultImport) {
        specifiers.push(defaultImport.getText());
      }

      for (const named of imp.getNamedImports()) {
        specifiers.push(named.getName());
      }

      const namespaceImport = imp.getNamespaceImport();
      if (namespaceImport) {
        specifiers.push(namespaceImport.getText());
      }

      const isTypeOnly = imp.isTypeOnly();
      const isExternal = this.isExternalModule(moduleSpecifier);
      
      let resolvedPath: string | null = null;
      if (!isExternal) {
        try {
          const resolvedSourceFile = imp.getModuleSpecifier().getSymbol()?.getDeclarations()?.[0]?.getSourceFile();
          if (resolvedSourceFile) {
            resolvedPath = resolvedSourceFile.getFilePath();
          }
        } catch {
          // Resolve using standard path utilities if ts-morph type checker cannot resolve
        }
      }

      imports.push({
        source: moduleSpecifier,
        resolvedPath,
        specifiers,
        isTypeOnly,
        isExternal,
        isDynamic: false,
      });
    }

    // Dynamic imports: import('...')
    sourceFile.forEachDescendant(node => {
      if (node.getKind() === SyntaxKind.CallExpression) {
        const expression = (node as any).getExpression?.();
        if (expression && expression.getKind() === SyntaxKind.ImportKeyword) {
          const args = (node as any).getArguments?.();
          if (args && args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
            const moduleSpecifier = args[0].getLiteralValue();
            const isExternal = this.isExternalModule(moduleSpecifier);
            imports.push({
              source: moduleSpecifier,
              resolvedPath: null, // Dynamic imports resolved dynamically
              specifiers: [],
              isTypeOnly: false,
              isExternal,
              isDynamic: true,
            });
          }
        }
      }
    });

    return imports;
  }

  private isExternalModule(moduleSpecifier: string): boolean {
    return !moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/');
  }
}
