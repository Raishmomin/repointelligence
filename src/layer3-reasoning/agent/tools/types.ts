import * as vscode from 'vscode';
import { DatabaseManager } from '../../../layer2-context/database/DatabaseManager';
import { HybridSearchEngine } from '../../../layer2-context/search/HybridSearchEngine';
import { CommandRequest, FileOperation } from '../../../shared/types/agent.types';
import { LlmToolSchema } from '../../providers/types';
import { FileStateTracker } from '../FileStateTracker';

/**
 * How much scrutiny a tool's effects require before they happen.
 *
 * `auto` tools run immediately with no prompt — reads and searches, which the agent needs
 * to do constantly and which cannot damage anything. Everything that writes to disk or
 * runs a process is a proposal the user approves first.
 */
export type ApprovalClass = 'auto' | 'file-write' | 'command';

/**
 * A tool either produced a result to feed straight back to the model, or produced a
 * proposal that parks the run until the user decides.
 */
export type ToolOutcome =
  | { kind: 'result'; content: string; isError?: boolean }
  | { kind: 'file-proposal'; operation: FileOperation; summary: string }
  | { kind: 'command-proposal'; request: Omit<CommandRequest, 'id' | 'runId'> };

/**
 * Everything a tool needs, injected rather than fetched from the service container.
 * This is what lets tools be unit tested without a running extension host.
 */
export interface ToolContext {
  workspace: vscode.WorkspaceFolder;
  fileState: FileStateTracker;
  database: DatabaseManager;
  searchEngine: HybridSearchEngine;
  token: vscode.CancellationToken;
  /** Current loop iteration, recorded against reads for staleness diagnostics. */
  turn: number;
  /** Path segments the agent must never traverse, from `agent.ignorePatterns`. */
  ignorePatterns: readonly string[];
}

export interface AgentTool<TArgs = Record<string, unknown>> {
  readonly name: string;
  /**
   * Shown to the model verbatim. Descriptions state *when* to reach for the tool, not
   * just what it does — recent models are conservative about tool use, and a trigger
   * condition measurably improves whether the right tool gets called.
   */
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly approval: ApprovalClass;

  /** Throws ToolArgumentError with a message written for the model to act on. */
  parseArgs(raw: unknown): TArgs;

  execute(args: TArgs, context: ToolContext): Promise<ToolOutcome>;
}

/** Argument validation failure. Surfaced as a tool error result so the model can retry. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

export function toSchema(tool: AgentTool): LlmToolSchema {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

// ── Argument helpers ─────────────────────────────────────────
// Every tool validates its own arguments; models routinely omit fields, send numbers as
// strings, or pass null where an object belongs.

export function asRecord(raw: unknown, toolName: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolArgumentError(`${toolName} expects an object of arguments.`);
  }
  return raw as Record<string, unknown>;
}

export function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value === '') {
    throw new ToolArgumentError(`"${field}" is required and must be a non-empty string.`);
  }
  return value;
}

/** Distinguishes an omitted field from one explicitly given a wrong type. */
export function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolArgumentError(`"${field}" must be a string when provided.`);
  }
  return value;
}

/** Allows a numeric string, which models produce often enough to be worth accepting. */
export function optionalNumber(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ToolArgumentError(`"${field}" must be a number when provided.`);
  }
  return parsed;
}

export function optionalBoolean(args: Record<string, unknown>, field: string): boolean | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ToolArgumentError(`"${field}" must be a boolean when provided.`);
}

export function requireStringArray(args: Record<string, unknown>, field: string): string[] {
  const value = args[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ToolArgumentError(`"${field}" must be an array of strings.`);
  }
  return value as string[];
}
