import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { FileOperation } from '../../../shared/types/agent.types';
import { classifyFileRisk, contentHash, isSafeCommand } from '../AgentSafety';
import { resolveAgentPath } from '../pathGuard';
import { applyInsert, applyStrReplace } from './strReplace';
import {
  AgentTool,
  asRecord,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  requireStringArray,
  ToolContext,
  ToolOutcome,
} from './types';

/**
 * Tools that change something. None of them touch disk directly — each returns a proposal
 * that the user approves, and ChangeSetService performs the actual write.
 *
 * Every edit tool runs the same three-step gate first:
 *   1. Resolve the path inside the workspace (pathGuard).
 *   2. Re-read the file from disk and check it against what the agent read (FileStateTracker).
 *   3. Compute the new content.
 *
 * Step 2 failures return an error *result*, not an exception — the model is told to
 * re-read and can recover on the next turn.
 */

async function readForEdit(
  relativePath: string,
  context: ToolContext,
): Promise<{ ok: true; absolute: string; content: string } | { ok: false; outcome: ToolOutcome }> {
  const absolute = resolveAgentPath(context.workspace.uri.fsPath, relativePath, context.ignorePatterns);

  let content: string;
  try {
    content = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        outcome: {
          kind: 'result',
          isError: true,
          content: `${relativePath} does not exist. Use create_file to make a new file.`,
        },
      };
    }
    throw error;
  }

  // Checked against content just read from disk, so an external change since the agent's
  // read is caught here rather than silently applied later.
  const check = context.fileState.checkEditable(relativePath, content);
  if (!check.ok) {
    return { ok: false, outcome: { kind: 'result', isError: true, content: check.message } };
  }

  return { ok: true, absolute, content };
}

function editOperation(
  relativePath: string,
  before: string,
  after: string,
  reason: string | undefined,
): FileOperation {
  return {
    id: randomUUID(),
    kind: 'edit',
    path: relativePath,
    content: after,
    beforeContent: before,
    // Re-verified at apply time; approval can sit pending for minutes.
    baseHash: contentHash(before),
    risk: classifyFileRisk('edit', relativePath),
    reason,
  };
}

export const strReplaceTool: AgentTool<{
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  reason?: string;
}> = {
  name: 'str_replace',
  description:
    'Replace an exact string in a file. This is the preferred way to edit — change only ' +
    'the lines that need to change rather than rewriting the file. old_string must match ' +
    'the file exactly, including whitespace, and must be unique unless replace_all is set. ' +
    'You must read the file first.',
  approval: 'file-write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path of the file to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace, with enough context to be unique.' },
      new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
      reason: { type: 'string', description: 'One-line explanation shown to the user for approval.' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'str_replace');
    const newString = args.new_string;
    if (typeof newString !== 'string') {
      // Explicitly allowed to be empty (deletion), so requireString would be wrong.
      throw new Error('"new_string" is required and must be a string (use "" to delete).');
    }
    return {
      path: requireString(args, 'path'),
      old_string: requireString(args, 'old_string'),
      new_string: newString,
      replace_all: optionalBoolean(args, 'replace_all'),
      reason: optionalString(args, 'reason'),
    };
  },
  async execute(args, context): Promise<ToolOutcome> {
    const opened = await readForEdit(args.path, context);
    if (!opened.ok) return opened.outcome;

    const replaced = applyStrReplace(opened.content, args.old_string, args.new_string, args.replace_all ?? false);
    if (!replaced.ok) {
      return { kind: 'result', isError: true, content: replaced.message };
    }

    const count = replaced.count > 1 ? ` (${replaced.count} occurrences)` : '';
    return {
      kind: 'file-proposal',
      operation: editOperation(args.path, opened.content, replaced.result, args.reason),
      summary: args.reason ?? `Edit ${args.path}${count}`,
    };
  },
};

export const insertTool: AgentTool<{
  path: string;
  insert_line: number;
  text: string;
  reason?: string;
}> = {
  name: 'insert_lines',
  description:
    'Insert text after a given line number without replacing anything. Use this to add ' +
    'imports, new functions, or new cases. insert_line 0 inserts at the top of the file. ' +
    'You must read the file first.',
  approval: 'file-write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path of the file to edit.' },
      insert_line: { type: 'number', description: 'Line number to insert after; 0 for the top of the file.' },
      text: { type: 'string', description: 'Text to insert.' },
      reason: { type: 'string', description: 'One-line explanation shown to the user for approval.' },
    },
    required: ['path', 'insert_line', 'text'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'insert_lines');
    const line = optionalNumber(args, 'insert_line');
    if (line === undefined) throw new Error('"insert_line" is required and must be a number.');
    const text = args.text;
    if (typeof text !== 'string') throw new Error('"text" is required and must be a string.');
    return {
      path: requireString(args, 'path'),
      insert_line: line,
      text,
      reason: optionalString(args, 'reason'),
    };
  },
  async execute(args, context): Promise<ToolOutcome> {
    const opened = await readForEdit(args.path, context);
    if (!opened.ok) return opened.outcome;

    const inserted = applyInsert(opened.content, args.insert_line, args.text);
    if (!inserted.ok) {
      return { kind: 'result', isError: true, content: inserted.message };
    }

    return {
      kind: 'file-proposal',
      operation: editOperation(args.path, opened.content, inserted.result, args.reason),
      summary: args.reason ?? `Insert into ${args.path} at line ${args.insert_line}`,
    };
  },
};

export const createFileTool: AgentTool<{ path: string; content: string; reason?: string }> = {
  name: 'create_file',
  description:
    'Create a new file with the given contents. Fails if the file already exists — use ' +
    'str_replace to change an existing file.',
  approval: 'file-write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path of the file to create.' },
      content: { type: 'string', description: 'Full contents of the new file.' },
      reason: { type: 'string', description: 'One-line explanation shown to the user for approval.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'create_file');
    const content = args.content;
    if (typeof content !== 'string') throw new Error('"content" is required and must be a string.');
    return { path: requireString(args, 'path'), content, reason: optionalString(args, 'reason') };
  },
  async execute(args, context): Promise<ToolOutcome> {
    const absolute = resolveAgentPath(context.workspace.uri.fsPath, args.path, context.ignorePatterns);

    // Read-before-Edit does not apply — there is nothing to read — but overwriting an
    // existing file unseen is exactly the accident the invariant exists to prevent.
    const exists = await fs
      .stat(absolute)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return {
        kind: 'result',
        isError: true,
        content: `${args.path} already exists. Read it and use str_replace to change it.`,
      };
    }

    return {
      kind: 'file-proposal',
      operation: {
        id: randomUUID(),
        kind: 'create',
        path: args.path,
        content: args.content,
        risk: classifyFileRisk('create', args.path),
        reason: args.reason,
      },
      summary: args.reason ?? `Create ${args.path}`,
    };
  },
};

export const deleteFileTool: AgentTool<{ path: string; reason?: string }> = {
  name: 'delete_file',
  description: 'Delete a file. Use sparingly, and explain why in the reason.',
  approval: 'file-write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path of the file to delete.' },
      reason: { type: 'string', description: 'Why this file should be removed.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'delete_file');
    return { path: requireString(args, 'path'), reason: optionalString(args, 'reason') };
  },
  async execute(args, context): Promise<ToolOutcome> {
    const opened = await readForEdit(args.path, context);
    if (!opened.ok) return opened.outcome;

    return {
      kind: 'file-proposal',
      operation: {
        id: randomUUID(),
        kind: 'delete',
        path: args.path,
        // Retained so revert can restore the file.
        beforeContent: opened.content,
        baseHash: contentHash(opened.content),
        risk: classifyFileRisk('delete', args.path),
        reason: args.reason,
      },
      summary: args.reason ?? `Delete ${args.path}`,
    };
  },
};

export const renameFileTool: AgentTool<{ path: string; new_path: string; reason?: string }> = {
  name: 'rename_file',
  description: 'Rename or move a file within the workspace.',
  approval: 'file-write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Current workspace-relative path.' },
      new_path: { type: 'string', description: 'New workspace-relative path.' },
      reason: { type: 'string', description: 'One-line explanation shown to the user for approval.' },
    },
    required: ['path', 'new_path'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const args = asRecord(raw, 'rename_file');
    return {
      path: requireString(args, 'path'),
      new_path: requireString(args, 'new_path'),
      reason: optionalString(args, 'reason'),
    };
  },
  async execute(args, context): Promise<ToolOutcome> {
    const root = context.workspace.uri.fsPath;
    // Both ends must be inside the workspace; the destination is otherwise an escape hatch.
    resolveAgentPath(root, args.path, context.ignorePatterns);
    const destination = resolveAgentPath(root, args.new_path, context.ignorePatterns);

    const opened = await readForEdit(args.path, context);
    if (!opened.ok) return opened.outcome;

    const occupied = await fs
      .stat(destination)
      .then(() => true)
      .catch(() => false);
    if (occupied) {
      return { kind: 'result', isError: true, content: `${args.new_path} already exists.` };
    }

    return {
      kind: 'file-proposal',
      operation: {
        id: randomUUID(),
        kind: 'rename',
        path: args.path,
        newPath: args.new_path,
        beforeContent: opened.content,
        baseHash: contentHash(opened.content),
        risk: classifyFileRisk('rename', args.path),
        reason: args.reason,
      },
      summary: args.reason ?? `Rename ${args.path} to ${args.new_path}`,
    };
  },
};

export const runCommandTool: AgentTool<{ command: string; args: string[]; reason: string }> = {
  name: 'run_command',
  description:
    'Propose a shell command for the user to approve, such as running tests or a build. ' +
    'The command and its arguments are passed separately — shell syntax such as pipes, ' +
    'redirects, and && is not supported and will be rejected.',
  approval: 'command',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Executable name only, e.g. "npm".' },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments as separate strings, e.g. ["run", "test"].',
      },
      reason: { type: 'string', description: 'Why this command needs to run.' },
    },
    required: ['command', 'args', 'reason'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const parsed = asRecord(raw, 'run_command');
    return {
      command: requireString(parsed, 'command'),
      args: requireStringArray(parsed, 'args'),
      reason: requireString(parsed, 'reason'),
    };
  },
  async execute(args, context): Promise<ToolOutcome> {
    if (!isSafeCommand(args.command, args.args)) {
      return {
        kind: 'result',
        isError: true,
        content:
          'Rejected: "command" must be a bare executable name with no shell syntax, and ' +
          'arguments must be passed separately in "args". For example use ' +
          '{"command":"npm","args":["run","test"]}, not {"command":"npm run test"}.',
      };
    }

    return {
      kind: 'command-proposal',
      request: {
        workspaceUri: context.workspace.uri.toString(),
        command: args.command,
        args: args.args,
        cwd: context.workspace.uri.fsPath,
        reason: args.reason,
        risk: classifyCommandRisk(args.command, args.args),
        status: 'pending',
      },
    };
  },
};

function classifyCommandRisk(command: string, args: string[]): 'low' | 'medium' | 'high' {
  if (/^(rm|mv|git|ssh|curl|wget)$/i.test(command)) return 'high';
  if (args.some((arg) => /install|remove|delete|reset|push|publish|--force|-f$/i.test(arg))) return 'high';
  return 'medium';
}

export const WRITE_TOOLS = [
  strReplaceTool,
  insertTool,
  createFileTool,
  deleteFileTool,
  renameFileTool,
  runCommandTool,
];
