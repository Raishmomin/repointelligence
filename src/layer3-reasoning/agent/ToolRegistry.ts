import { TaskMode } from '../../shared/types/agent.types';
import { LlmToolSchema } from '../providers/types';
import { READ_TOOLS } from './tools/readTools';
import { AgentTool, ToolArgumentError, ToolContext, ToolOutcome, toSchema } from './tools/types';
import { WRITE_TOOLS } from './tools/writeTools';

const ALL_TOOLS: AgentTool<never>[] = [...READ_TOOLS, ...WRITE_TOOLS] as AgentTool<never>[];

/**
 * Owns the tool set and dispatches calls to it.
 *
 * The schema list is sorted by name and never varies within a run. Tool definitions render
 * at position 0 of the cached prompt prefix, so reordering or conditionally hiding a tool
 * would invalidate the cache for every request that follows — which is why read-only modes
 * are enforced at execution time rather than by withholding tools from the model.
 */
export class ToolRegistry {
  private readonly byName: Map<string, AgentTool<never>>;

  constructor(private readonly tools: AgentTool<never>[] = ALL_TOOLS) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Stable, sorted schemas for the provider. */
  schemas(): LlmToolSchema[] {
    return [...this.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => toSchema(tool as AgentTool));
  }

  names(): string[] {
    return this.schemas().map((schema) => schema.name);
  }

  get(name: string): AgentTool<never> | undefined {
    return this.byName.get(name);
  }

  /**
   * Runs a tool call, converting every expected failure into an error *result* rather than
   * an exception. An unknown tool, bad arguments, or a blocked path should cost the agent
   * one turn and a correction — not the whole run.
   */
  async execute(
    name: string,
    rawArgs: unknown,
    context: ToolContext,
    mode: TaskMode,
  ): Promise<ToolOutcome> {
    const tool = this.byName.get(name);
    if (!tool) {
      return {
        kind: 'result',
        isError: true,
        content: `Unknown tool "${name}". Available tools: ${this.names().join(', ')}.`,
      };
    }

    // Explain and plan modes are advisory: the agent may look at anything but must not
    // propose changes. Enforced here rather than by removing tools, to keep the cached
    // tool list identical across modes.
    if (mode !== 'implement' && tool.approval !== 'auto') {
      return {
        kind: 'result',
        isError: true,
        content:
          `${name} makes changes, which is not allowed in ${mode} mode. ` +
          'Describe what you would change instead, and let the user switch to implement mode.',
      };
    }

    let args: never;
    try {
      args = tool.parseArgs(rawArgs) as never;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'result', isError: true, content: `Invalid arguments for ${name}: ${message}` };
    }

    try {
      return await tool.execute(args, context);
    } catch (error) {
      if (error instanceof ToolArgumentError) {
        return { kind: 'result', isError: true, content: `Invalid arguments for ${name}: ${error.message}` };
      }
      // Path-guard rejections and I/O failures land here. The model can usually recover by
      // choosing a different path, so this is reported rather than thrown.
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'result', isError: true, content: `${name} failed: ${message}` };
    }
  }
}
