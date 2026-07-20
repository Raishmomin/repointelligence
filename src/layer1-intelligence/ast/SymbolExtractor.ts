// ═══════════════════════════════════════════════════════════════
// Symbol Extractor — Extract functions, classes, hooks, components
// ═══════════════════════════════════════════════════════════════

import {
  SourceFile, FunctionDeclaration, ClassDeclaration,
  InterfaceDeclaration, TypeAliasDeclaration, EnumDeclaration,
  VariableDeclaration, VariableStatement, SyntaxKind, Node,
} from 'ts-morph';
import { SymbolInfo, SymbolKind, ExportInfo, LocationRange } from '../../shared/types/ast.types';

/**
 * Extracts all meaningful code symbols from a TypeScript source file.
 * Recognizes React components, hooks, NestJS decorators, and standard
 * TypeScript constructs (functions, classes, interfaces, types, enums).
 */
export class SymbolExtractor {

  /**
   * Extract all symbols from a source file.
   */
  extract(sourceFile: SourceFile): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];

    // Functions (top-level + exported)
    for (const fn of sourceFile.getFunctions()) {
      symbols.push(this.extractFunction(fn));
    }

    // Classes
    for (const cls of sourceFile.getClasses()) {
      symbols.push(this.extractClass(cls));
    }

    // Interfaces
    for (const iface of sourceFile.getInterfaces()) {
      symbols.push(this.extractInterface(iface));
    }

    // Type aliases
    for (const typeAlias of sourceFile.getTypeAliases()) {
      symbols.push(this.extractTypeAlias(typeAlias));
    }

    // Enums
    for (const enumDecl of sourceFile.getEnums()) {
      symbols.push(this.extractEnum(enumDecl));
    }

    // Variable declarations (const/let — includes arrow functions, components, hooks)
    for (const varStmt of sourceFile.getVariableStatements()) {
      for (const decl of varStmt.getDeclarations()) {
        const sym = this.extractVariable(decl, varStmt);
        if (sym) symbols.push(sym);
      }
    }

    return symbols;
  }

  /**
   * Extract export information from a source file.
   */
  extractExports(sourceFile: SourceFile): ExportInfo[] {
    const exports: ExportInfo[] = [];

    // Named exports
    for (const exp of sourceFile.getExportDeclarations()) {
      const moduleSpecifier = exp.getModuleSpecifierValue();
      for (const named of exp.getNamedExports()) {
        exports.push({
          name: named.getName(),
          kind: 'variable',
          isDefault: false,
          isReExport: !!moduleSpecifier,
          source: moduleSpecifier ?? null,
        });
      }
    }

    // Default export
    const defaultExport = sourceFile.getDefaultExportSymbol();
    if (defaultExport) {
      exports.push({
        name: defaultExport.getName(),
        kind: 'variable',
        isDefault: true,
        isReExport: false,
        source: null,
      });
    }

    // Export assignments (export = ...)
    const exportAssignment = sourceFile.getExportAssignment(d => !d.isExportEquals());
    if (exportAssignment) {
      exports.push({
        name: 'default',
        kind: 'variable',
        isDefault: true,
        isReExport: false,
        source: null,
      });
    }

    return exports;
  }

  // ── Private extractors ──────────────────────────────────────

  private extractFunction(fn: FunctionDeclaration): SymbolInfo {
    const name = fn.getName() ?? 'anonymous';
    const isHook = name.startsWith('use') && name.length > 3 && name[3] === name[3].toUpperCase();
    const isComponent = this.hasJSXReturn(fn) || (name[0] === name[0].toUpperCase() && name[0] !== '_');

    return {
      name,
      kind: isHook ? 'hook' : isComponent ? 'component' : 'function',
      signature: this.buildFunctionSignature(fn),
      documentation: this.getJsDoc(fn),
      location: this.getLocation(fn),
      complexity: this.calculateCyclomaticComplexity(fn),
      dependencies: [],
      isExported: fn.isExported(),
      isDefault: fn.isDefaultExport(),
      decorators: [],
      metadata: {
        isAsync: fn.isAsync(),
        parameters: fn.getParameters().map(p => ({
          name: p.getName(),
          type: p.getType().getText(p),
          optional: p.isOptional(),
        })),
        returnType: fn.getReturnType().getText(fn),
        isExported: fn.isExported(),
      },
    };
  }

  private extractClass(cls: ClassDeclaration): SymbolInfo {
    const decorators = cls.getDecorators().map(d => d.getName());
    const isNestController = decorators.includes('Controller');
    const isNestService = decorators.includes('Injectable');
    const isNestModule = decorators.includes('Module');

    let kind: SymbolKind = 'class';
    if (isNestController || isNestService || isNestModule) kind = 'class';

    const methods = cls.getMethods().map(m => ({
      name: m.getName(),
      decorators: m.getDecorators().map(d => d.getName()),
      isAsync: m.isAsync(),
      visibility: m.getScope?.() ?? 'public',
    }));

    return {
      name: cls.getName() ?? 'AnonymousClass',
      kind,
      signature: `class ${cls.getName() ?? 'Anonymous'}${cls.getExtends() ? ` extends ${cls.getExtends()!.getText()}` : ''}`,
      documentation: this.getJsDoc(cls),
      location: this.getLocation(cls),
      complexity: cls.getMethods().reduce((sum, m) => sum + this.calculateCyclomaticComplexity(m), 0),
      dependencies: [],
      isExported: cls.isExported(),
      isDefault: cls.isDefaultExport(),
      decorators,
      metadata: {
        isAbstract: cls.isAbstract(),
        implements: cls.getImplements().map(i => i.getText()),
        extends: cls.getExtends()?.getText() ?? null,
        methods,
        properties: cls.getProperties().map(p => ({
          name: p.getName(),
          type: p.getType().getText(p),
          decorators: p.getDecorators().map(d => d.getName()),
        })),
        nestType: isNestController ? 'controller' : isNestService ? 'service' : isNestModule ? 'module' : null,
        isExported: cls.isExported(),
      },
    };
  }

  private extractInterface(iface: InterfaceDeclaration): SymbolInfo {
    return {
      name: iface.getName(),
      kind: 'interface',
      signature: `interface ${iface.getName()}`,
      documentation: this.getJsDoc(iface),
      location: this.getLocation(iface),
      complexity: 0,
      dependencies: [],
      isExported: iface.isExported(),
      isDefault: iface.isDefaultExport(),
      decorators: [],
      metadata: {
        properties: iface.getProperties().map(p => ({
          name: p.getName(),
          type: p.getType().getText(p),
          optional: p.hasQuestionToken(),
        })),
        extends: iface.getExtends().map(e => e.getText()),
        isExported: iface.isExported(),
      },
    };
  }

  private extractTypeAlias(typeAlias: TypeAliasDeclaration): SymbolInfo {
    return {
      name: typeAlias.getName(),
      kind: 'type',
      signature: `type ${typeAlias.getName()} = ${typeAlias.getType().getText(typeAlias).substring(0, 100)}`,
      documentation: this.getJsDoc(typeAlias),
      location: this.getLocation(typeAlias),
      complexity: 0,
      dependencies: [],
      isExported: typeAlias.isExported(),
      isDefault: typeAlias.isDefaultExport(),
      decorators: [],
      metadata: { isExported: typeAlias.isExported() },
    };
  }

  private extractEnum(enumDecl: EnumDeclaration): SymbolInfo {
    return {
      name: enumDecl.getName(),
      kind: 'enum',
      signature: `enum ${enumDecl.getName()}`,
      documentation: this.getJsDoc(enumDecl),
      location: this.getLocation(enumDecl),
      complexity: 0,
      dependencies: [],
      isExported: enumDecl.isExported(),
      isDefault: enumDecl.isDefaultExport(),
      decorators: [],
      metadata: {
        members: enumDecl.getMembers().map(m => ({
          name: m.getName(),
          value: m.getValue(),
        })),
        isExported: enumDecl.isExported(),
      },
    };
  }

  private extractVariable(decl: VariableDeclaration, stmt: VariableStatement): SymbolInfo | null {
    const name = decl.getName();
    if (!name || name === '_') return null;

    const initializer = decl.getInitializer();
    if (!initializer) return null; // Skip uninitialized declarations

    const isArrowFunction = initializer.getKind() === SyntaxKind.ArrowFunction;
    const isFunctionExpression = initializer.getKind() === SyntaxKind.FunctionExpression;
    const isFunction = isArrowFunction || isFunctionExpression;

    // Detect hooks
    const isHook = name.startsWith('use') && name.length > 3 && name[3] === name[3].toUpperCase();

    // Detect React components (PascalCase arrow functions that might return JSX)
    const isPascalCase = name[0] === name[0].toUpperCase() && name[0] !== '_';
    const isComponent = isFunction && isPascalCase && !isHook;

    // Detect constants (ALL_CAPS)
    const isConstant = /^[A-Z][A-Z0-9_]*$/.test(name);

    let kind: SymbolKind;
    if (isHook) kind = 'hook';
    else if (isComponent) kind = 'component';
    else if (isConstant) kind = 'constant';
    else if (isFunction) kind = 'function';
    else kind = 'variable';

    // Build signature
    let signature = '';
    if (isFunction) {
      const typeText = decl.getType().getText(decl);
      signature = `const ${name}: ${typeText.substring(0, 150)}`;
    } else {
      signature = `const ${name} = ${initializer.getText().substring(0, 80)}`;
    }

    return {
      name,
      kind,
      signature,
      documentation: this.getJsDoc(stmt),
      location: this.getLocation(decl),
      complexity: isFunction ? this.calculateCyclomaticComplexity(initializer) : 0,
      dependencies: [],
      isExported: stmt.isExported(),
      isDefault: stmt.isDefaultExport(),
      decorators: [],
      metadata: {
        declarationKind: stmt.getDeclarationKind(),
        isExported: stmt.isExported(),
      },
    };
  }

  // ── Helpers ──────────────────────────────────────────────────

  private getLocation(node: Node): LocationRange {
    return {
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      startCol: node.getStart() - node.getStartLinePos(),
      endCol: 0,
    };
  }

  private getJsDoc(node: Node): string {
    try {
      const jsDocs = (node as any).getJsDocs?.();
      if (jsDocs && jsDocs.length > 0) {
        return jsDocs.map((d: any) => d.getDescription?.() ?? d.getText()).join('\n').trim();
      }
    } catch {
      // Not all nodes support getJsDocs
    }
    return '';
  }

  private buildFunctionSignature(fn: FunctionDeclaration): string {
    const name = fn.getName() ?? 'anonymous';
    const params = fn.getParameters().map(p => {
      const type = p.getType().getText(p);
      return `${p.getName()}${p.isOptional() ? '?' : ''}: ${type}`;
    }).join(', ');
    const returnType = fn.getReturnType().getText(fn);
    const asyncPrefix = fn.isAsync() ? 'async ' : '';
    return `${asyncPrefix}function ${name}(${params}): ${returnType}`;
  }

  private hasJSXReturn(node: Node): boolean {
    try {
      const text = node.getText();
      return text.includes('JSX.Element') || text.includes('React.FC') ||
             text.includes('ReactNode') || text.includes('<') && text.includes('/>');
    } catch {
      return false;
    }
  }

  /**
   * Calculate cyclomatic complexity by counting branching statements.
   */
  private calculateCyclomaticComplexity(node: Node): number {
    let complexity = 1;
    try {
      node.forEachDescendant((child) => {
        switch (child.getKind()) {
          case SyntaxKind.IfStatement:
          case SyntaxKind.ConditionalExpression:
          case SyntaxKind.ForStatement:
          case SyntaxKind.ForInStatement:
          case SyntaxKind.ForOfStatement:
          case SyntaxKind.WhileStatement:
          case SyntaxKind.DoStatement:
          case SyntaxKind.CatchClause:
          case SyntaxKind.CaseClause:
            complexity++;
            break;
          case SyntaxKind.BinaryExpression:
            {
              const op = child.getChildAtIndex(1)?.getText();
              if (op === '&&' || op === '||' || op === '??') complexity++;
            }
            break;
        }
      });
    } catch {
      // Ignore traversal errors
    }
    return complexity;
  }
}
