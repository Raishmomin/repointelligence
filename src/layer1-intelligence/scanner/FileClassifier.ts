// ═══════════════════════════════════════════════════════════════
// File Classifier — Categorize files by path patterns & naming
// ═══════════════════════════════════════════════════════════════

import * as path from 'path';
import { FileCategory } from '../../shared/types/scanner.types';
import { isTestFile, isConfigFile } from '../../shared/utils/fileUtils';

/**
 * Classifies files into categories based on path segments, naming conventions,
 * and directory structure. This is a fast heuristic classifier — deeper
 * classification happens during AST analysis (Phase 2).
 */
export class FileClassifier {
  /**
   * Classify a file based on its relative path.
   * Order matters — more specific rules take priority.
   */
  classify(relativePath: string): FileCategory {
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
    const basename = path.basename(relativePath, path.extname(relativePath)).toLowerCase();
    const ext = path.extname(relativePath).toLowerCase();
    const dirParts = path.dirname(relativePath).replace(/\\/g, '/').toLowerCase().split('/');

    // ── Tests ─────────────────────────────────────────────
    if (isTestFile(relativePath)) return 'test';

    // ── Configs ───────────────────────────────────────────
    if (isConfigFile(relativePath)) return 'config';

    // ── Styles ────────────────────────────────────────────
    if (['.css', '.scss', '.sass', '.less'].includes(ext)) return 'style';

    // ── NestJS-specific (decorator-based naming) ──────────
    if (basename.endsWith('.controller')) return 'controller';
    if (basename.endsWith('.service')) return 'service';
    if (basename.endsWith('.module')) return 'module';
    if (basename.endsWith('.guard')) return 'guard';
    if (basename.endsWith('.pipe')) return 'pipe';
    if (basename.endsWith('.interceptor')) return 'interceptor';
    if (basename.endsWith('.decorator')) return 'decorator';
    if (basename.endsWith('.middleware')) return 'middleware';
    if (basename.endsWith('.provider')) return 'provider';
    if (basename.endsWith('.gateway')) return 'service';

    // ── Models / Schemas / Migrations ─────────────────────
    if (basename.endsWith('.entity') || basename.endsWith('.model')) return 'model';
    if (basename.endsWith('.schema')) return 'schema';
    if (basename.endsWith('.migration')) return 'migration';
    if (dirParts.includes('models') || dirParts.includes('entities')) return 'model';
    if (dirParts.includes('schemas')) return 'schema';
    if (dirParts.includes('migrations')) return 'migration';

    // ── Type definitions ──────────────────────────────────
    if (basename.endsWith('.types') || basename.endsWith('.type')) return 'type';
    if (basename.endsWith('.interface') || basename.endsWith('.interfaces')) return 'interface';
    if (basename.endsWith('.enum') || basename.endsWith('.enums')) return 'enum';
    if (basename.endsWith('.constants') || basename.endsWith('.constant')) return 'constant';
    if (ext === '.d.ts') return 'type';
    if (dirParts.includes('types') || dirParts.includes('interfaces')) return 'type';

    // ── React Hooks ───────────────────────────────────────
    if (basename.startsWith('use') && basename.length > 3) return 'hook';
    if (dirParts.includes('hooks')) return 'hook';

    // ── React Context ─────────────────────────────────────
    if (basename.endsWith('.context') || basename.endsWith('context')) return 'context';
    if (dirParts.includes('contexts') || dirParts.includes('context')) return 'context';

    // ── State Management ──────────────────────────────────
    if (basename.endsWith('.store') || dirParts.includes('store') || dirParts.includes('stores')) return 'store';
    if (basename.endsWith('.reducer') || dirParts.includes('reducers')) return 'reducer';
    if (basename.endsWith('.action') || basename.endsWith('.actions') || dirParts.includes('actions')) return 'action';
    if (basename.endsWith('.slice')) return 'store';

    // ── API Routes ────────────────────────────────────────
    if (dirParts.includes('api') && dirParts.includes('app')) return 'api-route';
    if (dirParts.includes('api') && dirParts.includes('pages')) return 'api-route';
    if (normalized.includes('/api/')) return 'api-route';

    // ── Pages / Layouts ───────────────────────────────────
    if (basename === 'page' || basename === 'index') {
      if (dirParts.includes('app') || dirParts.includes('pages')) return 'page';
    }
    if (basename === 'layout' || basename.endsWith('.layout')) return 'layout';
    if (dirParts.includes('pages') || dirParts.includes('views')) return 'page';
    if (dirParts.includes('layouts')) return 'layout';

    // ── Components ────────────────────────────────────────
    if (dirParts.includes('components') || dirParts.includes('ui')) return 'component';
    if (['.tsx', '.jsx'].includes(ext)) return 'component'; // Default for JSX files

    // ── Services / Utilities ──────────────────────────────
    if (dirParts.includes('services') || basename.endsWith('.service')) return 'service';
    if (dirParts.includes('utils') || dirParts.includes('utilities') || dirParts.includes('helpers')) return 'utility';
    if (dirParts.includes('lib') || dirParts.includes('libs')) return 'lib';
    if (basename.endsWith('.util') || basename.endsWith('.utils')) return 'utility';
    if (basename.endsWith('.helper') || basename.endsWith('.helpers')) return 'helper';

    // ── Middleware ─────────────────────────────────────────
    if (dirParts.includes('middleware') || dirParts.includes('middlewares')) return 'middleware';

    return 'unknown';
  }
}
