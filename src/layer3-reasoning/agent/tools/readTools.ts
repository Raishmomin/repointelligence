import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveAgentPath } from '../pathGuard';
import {
  AgentTool,
  asRecord,
  optionalNumber,
  optionalString,
  requireString,
  ToolArgumentError,
  ToolContext,
  ToolOutcome,
} from './types';

const DEFAULT_READ_LIMIT = 2000;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 100;

/**
 * Generated directories that searches must not return.
 *
 * Deliberately separate from `agent.ignorePatterns`, which is an access-control list
 * enforced by the path guard — `.env` is a secret the agent must never open, whereas
 * `.next` is merely noise. Compiled output mirrors the real source closely enough that a
 * search for a component returns its build artefacts alongside (or instead of) the file
 * the user can actually edit, and on a framework that emits per-route bundles those
 * artefacts can crowd out every genuine hit before the result cap is reached.
 *
 * Excluding them here rather than in `ignorePatterns` keeps `read_file` able to open a
 * build artefact when someone explicitly asks about one.
 */
const SEARCH_NOISE_DIRS = [
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
];

/**
 * Builds the exclude pattern for findFiles.
 *
 * Empty entries are dropped: a brace expansion with an empty alternative
 * (`**\/{,out,dist}/**`) is not a pattern that reliably matches nothing, and
 * `ignorePatterns` is user-editable, so a stray empty string in settings should not be
 * able to change what the agent can see.
 */
/**
 * Rewrites a glob so its literal letters match either case.
 *
 * `vscode.workspace.findFiles` matches paths case-sensitively on a case-sensitive
 * filesystem, so on Linux `**​/*footer*` does not find `components/layout/Footer.tsx`
 * while on macOS it does. The agent then reports the file as missing on one machine and
 * finds it on another, which reads as the model being unreliable rather than the search
 * being wrong.
 *
 * Brace expansion of each letter (`f` becomes `[Ff]`) is the portable fix — findFiles
 * exposes no case-insensitivity flag. Characters already inside a class are left alone so
 * a hand-written `[A-Z]` keeps its meaning, and every glob metacharacter passes through
 * untouched.
 */
export function caseInsensitiveGlob(pattern: string): string {
  let out = '';
  let inClass = false;

  for (const char of pattern) {
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;

    if (!inClass && /[a-zA-Z]/.test(char)) {
      out += `[${char.toLowerCase()}${char.toUpperCase()}]`;
    } else {
      out += char;
    }
  }

  return out;
}

export function buildExcludeGlob(ignorePatterns: readonly string[]): string {
  const segments = [...new Set([...SEARCH_NOISE_DIRS, ...ignorePatterns])]
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');

  return `**/{${segments.join(',')}}/**`;
}

/**
 * Read-only tools. All are `auto` approval: the agent runs them freely so it can explore
 * without interrupting the user, and none of them can change anything.
 */

export const readFileTool: AgentTool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description:
    'Read a file from the workspace, returned with line numbers. Call this whenever you ' +
    'need to see a file you have not already read in this run — you must read a file ' +
    'before you can edit it. Use offset and limit to page through very large files. ' +
    'Requires a path you already know: if you are still looking for the file, call glob ' +
    'or grep on its own first and read the result on your next turn. Do not call this in ' +
    'the same turn as the search that finds the path — you will not have the path yet.',
  approval: 'auto',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path, e.g. "src/app.ts".' },
      offset: { type: 'number', description: '1-based line to start from. Defaults to the first line.' },
      limit: { type: 'number', description: `Maximum lines to return. Defaults to ${DEFAULT_READ_LIMIT}.` },
    },
    required: ['path'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'read_file');
    // A missing path here is almost always a model that queued read_file in the same turn
    // as the glob or grep meant to produce that path, so it had nothing to fill in. The
    // generic "must be a non-empty string" is true but leaves it to guess the remedy.
    if (args.path === undefined || args.path === null || args.path === '') {
      throw new ToolArgumentError(
        'No "path" was given. If you do not know the path yet, call glob or grep first ' +
          'and read the file on your next turn, once you can see the result.',
      );
    }
    return {
      path: requireString(args, 'path'),
      offset: optionalNumber(args, 'offset'),
      limit: optionalNumber(args, 'limit'),
    };
  },
  async execute(args, context): Promise<ToolOutcome> {
    const absolute = resolveAgentPath(context.workspace.uri.fsPath, args.path, context.ignorePatterns);

    let content: string;
    try {
      content = await fs.readFile(absolute, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { kind: 'result', isError: true, content: `${args.path} does not exist.` };
      }
      if (code === 'EISDIR') {
        return {
          kind: 'result',
          isError: true,
          content: `${args.path} is a directory. Use glob to list its contents.`,
        };
      }
      throw error;
    }

    // The full content is what the staleness hash is taken over, even when a slice is
    // returned — the agent's edits are checked against the file as a whole.
    context.fileState.recordRead(args.path, content, context.turn);

    const lines = content.split('\n');
    const start = Math.max(0, (args.offset ?? 1) - 1);
    const limit = args.limit ?? DEFAULT_READ_LIMIT;
    const slice = lines.slice(start, start + limit);

    const numbered = slice.map((line, index) => `${start + index + 1}\t${line}`).join('\n');
    const truncated = start + slice.length < lines.length;
    const footer = truncated
      ? `\n\n[showing lines ${start + 1}-${start + slice.length} of ${lines.length}; ` +
        `read again with offset ${start + slice.length + 1} for more]`
      : '';

    return { kind: 'result', content: numbered + footer };
  },
};

export const globTool: AgentTool<{ pattern: string; path?: string }> = {
  name: 'glob',
  description:
    'Find files by glob pattern, e.g. "src/**/*.ts". Call this when you need to locate ' +
    'files by name or extension and do not already know the exact path.',
  approval: 'auto',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern relative to the workspace root.' },
      path: { type: 'string', description: 'Optional subdirectory to search within.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'glob');
    return { pattern: requireString(args, 'pattern'), path: optionalString(args, 'path') };
  },
  async execute(args, context): Promise<ToolOutcome> {
    const scoped = args.path ? `${args.path.replace(/\/$/, '')}/${args.pattern}` : args.pattern;
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(context.workspace, caseInsensitiveGlob(scoped)),
      buildExcludeGlob(context.ignorePatterns),
      MAX_GLOB_RESULTS,
    );

    if (!found.length) {
      return { kind: 'result', content: `No files match ${scoped}.` };
    }

    const paths = found.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
    const note = paths.length === MAX_GLOB_RESULTS ? `\n\n[capped at ${MAX_GLOB_RESULTS} results]` : '';
    return { kind: 'result', content: paths.join('\n') + note };
  },
};

export const grepTool: AgentTool<{ pattern: string; glob?: string; path?: string }> = {
  name: 'grep',
  description:
    'Search file contents by regular expression, returning matching lines with their ' +
    'file and line number. Call this when you need to find where something is defined or ' +
    'used and do not know which file holds it.',
  approval: 'auto',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression.' },
      glob: { type: 'string', description: 'Optional file filter, e.g. "**/*.ts".' },
      path: { type: 'string', description: 'Optional subdirectory to search within.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'grep');
    return {
      pattern: requireString(args, 'pattern'),
      glob: optionalString(args, 'glob'),
      path: optionalString(args, 'path'),
    };
  },
  async execute(args, context): Promise<ToolOutcome> {
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern);
    } catch (error) {
      return {
        kind: 'result',
        isError: true,
        content: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const filter = args.glob ?? '**/*';
    const scoped = args.path ? `${args.path.replace(/\/$/, '')}/${filter}` : filter;
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(context.workspace, caseInsensitiveGlob(scoped)),
      buildExcludeGlob(context.ignorePatterns),
      1000,
    );

    const matches: string[] = [];
    for (const uri of files) {
      if (context.token.isCancellationRequested || matches.length >= MAX_GREP_RESULTS) break;

      let content: string;
      try {
        content = await fs.readFile(uri.fsPath, 'utf8');
      } catch {
        continue; // Binary or unreadable file; not an error worth reporting to the model.
      }

      const relative = vscode.workspace.asRelativePath(uri, false);
      const lines = content.split('\n');
      for (let index = 0; index < lines.length && matches.length < MAX_GREP_RESULTS; index++) {
        if (regex.test(lines[index])) {
          matches.push(`${relative}:${index + 1}: ${lines[index].trim()}`);
        }
      }
    }

    if (!matches.length) {
      return { kind: 'result', content: `No matches for /${args.pattern}/ in ${scoped}.` };
    }

    const note = matches.length === MAX_GREP_RESULTS ? `\n\n[capped at ${MAX_GREP_RESULTS} matches]` : '';
    return { kind: 'result', content: matches.join('\n') + note };
  },
};

export const queryIndexTool: AgentTool<{ query: string; limit?: number }> = {
  name: 'query_index',
  description:
    'Search the indexed knowledge base of this repository by meaning rather than exact ' +
    'text, returning the most relevant code. Call this first when starting an unfamiliar ' +
    'task, to find which parts of the codebase are relevant.',
  approval: 'auto',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language description of what you are looking for.' },
      limit: { type: 'number', description: 'Maximum results. Defaults to 5.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'query_index');
    return { query: requireString(args, 'query'), limit: optionalNumber(args, 'limit') };
  },
  async execute(args, context): Promise<ToolOutcome> {
    const root = context.workspace.uri.fsPath;
    const project = context.database.queryOne<{ id: string }>(
      'SELECT id FROM projects WHERE root_path = ?',
      [root],
    );

    if (!project) {
      return {
        kind: 'result',
        isError: true,
        content:
          'This workspace has not been indexed yet. Ask the user to run ' +
          '"Repo Intelligence: Scan Repository", or use glob and grep instead.',
      };
    }

    const results = await context.searchEngine.search(project.id, args.query, args.limit ?? 5);
    if (!results.length) {
      return { kind: 'result', content: `Nothing in the index matched "${args.query}".` };
    }

    const sections = results.map((item) => {
      const relative = path.relative(root, item.filePath);
      return `--- ${relative} ---\n${item.content}`;
    });
    return { kind: 'result', content: sections.join('\n\n') };
  },
};

export const READ_TOOLS = [readFileTool, globTool, grepTool, queryIndexTool];
