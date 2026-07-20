/**
 * Minimal stand-in for the `vscode` module so extension code can be unit tested
 * outside the extension host. Only the surface the agent layer actually touches is
 * implemented; anything else should be added here rather than mocked per-test.
 *
 * Wired in via the `vscode` alias in vitest.config.ts.
 */

// ── Configuration ────────────────────────────────────────────

/**
 * Configuration is modelled per-scope rather than as one flat map, because the code under
 * test makes real decisions from `inspect()` — object settings do not deep-merge across
 * scopes, so which scope a value lives in changes where a write must go.
 */
const globalValues = new Map<string, unknown>();
const workspaceValues = new Map<string, unknown>();

/** Test helper: seed a global-scope setting. */
export function __setConfig(fullKey: string, value: unknown): void {
  globalValues.set(fullKey, value);
}

/** Test helper: seed a workspace-scope setting, which shadows the global one. */
export function __setWorkspaceConfig(fullKey: string, value: unknown): void {
  workspaceValues.set(fullKey, value);
}

/** Test helper: read back what the code under test actually wrote. */
export function __getConfig(fullKey: string): unknown {
  return workspaceValues.has(fullKey) ? workspaceValues.get(fullKey) : globalValues.get(fullKey);
}

export function __resetConfig(): void {
  globalValues.clear();
  workspaceValues.clear();
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

class WorkspaceConfiguration {
  constructor(private readonly section: string) {}

  private full(key: string): string {
    return this.section ? `${this.section}.${key}` : key;
  }

  get<T>(key: string, defaultValue?: T): T {
    const full = this.full(key);
    if (workspaceValues.has(full)) return workspaceValues.get(full) as T;
    if (globalValues.has(full)) return globalValues.get(full) as T;
    return defaultValue as T;
  }

  has(key: string): boolean {
    const full = this.full(key);
    return workspaceValues.has(full) || globalValues.has(full);
  }

  inspect<T>(key: string): { globalValue?: T; workspaceValue?: T } | undefined {
    const full = this.full(key);
    return {
      globalValue: globalValues.has(full) ? (globalValues.get(full) as T) : undefined,
      workspaceValue: workspaceValues.has(full) ? (workspaceValues.get(full) as T) : undefined,
    };
  }

  async update(key: string, value: unknown, target?: ConfigurationTarget): Promise<void> {
    const store = target === ConfigurationTarget.Workspace ? workspaceValues : globalValues;
    store.set(this.full(key), value);
  }
}

// ── Uri ──────────────────────────────────────────────────────

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}
  static file(p: string): Uri {
    return new Uri('file', p);
  }
  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(value);
    return match ? new Uri(match[1], match[2]) : new Uri('file', value);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/'));
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

// ── Positions and ranges ─────────────────────────────────────

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number | Position, startChar?: number | Position, endLine?: number, endChar?: number) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine as number, endChar as number);
    }
  }
}

// ── WorkspaceEdit ────────────────────────────────────────────

export type RecordedEdit =
  | { kind: 'createFile'; uri: Uri; contents?: string }
  | { kind: 'deleteFile'; uri: Uri }
  | { kind: 'renameFile'; from: Uri; to: Uri }
  | { kind: 'replace'; uri: Uri; range: Range; text: string }
  | { kind: 'insert'; uri: Uri; position: Position; text: string };

export class WorkspaceEdit {
  /** Every operation recorded in order, for assertions. */
  readonly edits: RecordedEdit[] = [];
  createFile(uri: Uri, options?: { overwrite?: boolean; contents?: Uint8Array }): void {
    this.edits.push({
      kind: 'createFile',
      uri,
      contents: options?.contents ? Buffer.from(options.contents).toString('utf8') : undefined,
    });
  }
  deleteFile(uri: Uri): void {
    this.edits.push({ kind: 'deleteFile', uri });
  }
  renameFile(from: Uri, to: Uri): void {
    this.edits.push({ kind: 'renameFile', from, to });
  }
  replace(uri: Uri, range: Range, text: string): void {
    this.edits.push({ kind: 'replace', uri, range, text });
  }
  insert(uri: Uri, position: Position, text: string): void {
    this.edits.push({ kind: 'insert', uri, position, text });
  }
}

// ── Cancellation ─────────────────────────────────────────────

export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

export class CancellationTokenSource {
  private listeners: Array<() => void> = [];
  readonly token: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.push(listener);
      return new Disposable(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      });
    },
  };
  cancel(): void {
    if (this.token.isCancellationRequested) return;
    (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    this.listeners.forEach((l) => l());
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
  static from(...items: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  };
  fire(data: T): void {
    this.listeners.forEach((l) => l(data));
  }
  dispose(): void {
    this.listeners = [];
  }
}

// ── RelativePattern ──────────────────────────────────────────

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

// ── workspace ────────────────────────────────────────────────

let workspaceRoot = '/workspace';

/** Test helper: point `workspace.asRelativePath` and folder lookups at a temp dir. */
export function __setWorkspaceRoot(root: string): void {
  workspaceRoot = root;
}

export const workspace = {
  getConfiguration: (section = '') => new WorkspaceConfiguration(section),
  get workspaceFolders() {
    return [{ uri: Uri.file(workspaceRoot), name: 'test', index: 0 }];
  },
  asRelativePath: (uri: Uri | string) => {
    const p = typeof uri === 'string' ? uri : uri.fsPath;
    return p.startsWith(workspaceRoot) ? p.slice(workspaceRoot.length).replace(/^\//, '') : p;
  },
  findFiles: async () => [] as Uri[],
  applyEdit: async () => true,
  openTextDocument: async () => ({ getText: () => '' }),
  onDidChangeConfiguration: () => new Disposable(() => {}),
  fs: {
    createDirectory: async () => undefined,
  },
};

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  createOutputChannel: () => ({
    appendLine: () => {},
    append: () => {},
    show: () => {},
    dispose: () => {},
  }),
};

export const commands = {
  executeCommand: async () => undefined,
  registerCommand: () => new Disposable(() => {}),
};

export const extensions = {
  getExtension: () => undefined,
};
