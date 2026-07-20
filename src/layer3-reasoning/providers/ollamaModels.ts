/**
 * Heuristics for judging whether a local Ollama model can drive the agent.
 *
 * The agent needs a model that reliably emits structured tool calls. A small
 * general-purpose model cannot, and the way that failure presents is the model asking the
 * user where a file is instead of searching for it — which looks like a bug in the
 * extension rather than a model that is too small for the job.
 *
 * Pure and dependency-free: used both to warn at run time and to rank the setup picker.
 */

export type ToolCallingFitness = 'good' | 'marginal' | 'poor';

export interface ModelAssessment {
  fitness: ToolCallingFitness;
  /** Billions of parameters, parsed from the tag or the model's own metadata. */
  parameterBillions?: number;
  /** Shown to the user when fitness is not 'good'. */
  warning?: string;
}

/** Families trained for code and tool use, in rough order of how well they do it. */
const CODER_FAMILIES = [
  'qwen2.5-coder',
  'qwen3-coder',
  'deepseek-coder',
  'codellama',
  'codestral',
  'starcoder',
  'granite-code',
];

/** General families that handle tool calling acceptably at sufficient size. */
const CAPABLE_GENERAL_FAMILIES = ['qwen2.5', 'qwen3', 'llama3.1', 'llama3.2', 'llama3.3', 'mistral', 'mixtral', 'gemma3'];

const MIN_GOOD_BILLIONS = 7;
const MIN_MARGINAL_BILLIONS = 3;

/**
 * Parses a parameter count out of an Ollama model name.
 *
 * Handles `qwen2.5-coder:7b`, `llama3.1:70b`, `phi3:3.8b`, and `deepseek-coder-v2:16b`.
 * Returns undefined when the tag carries no size, which is common for `:latest`.
 */
export function parseParameterBillions(model: string): number | undefined {
  // Anchored on a token boundary so the "2.5" in "qwen2.5-coder" is not read as a size.
  const match = /(?:^|[:\-_])(\d+(?:\.\d+)?)\s*b(?:\b|$)/i.exec(model);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export function assessModel(model: string, parameterHint?: string): ModelAssessment {
  const name = model.toLowerCase();
  const parameterBillions = parseParameterBillions(model) ?? parseParameterBillions(parameterHint ?? '');

  const isCoder = CODER_FAMILIES.some((family) => name.includes(family));
  const isCapableGeneral = CAPABLE_GENERAL_FAMILIES.some((family) => name.includes(family));

  // Size dominates: a 1B coder model still cannot hold a tool protocol together.
  if (parameterBillions !== undefined && parameterBillions < MIN_MARGINAL_BILLIONS) {
    return {
      fitness: 'poor',
      parameterBillions,
      warning:
        `"${model}" is roughly a ${parameterBillions}B model, which is too small to emit ` +
        'reliable tool calls. It will tend to answer in prose — often by asking you where ' +
        'files are — instead of searching the repository itself. ' +
        'Try: ollama pull qwen2.5-coder:7b',
    };
  }

  if (parameterBillions !== undefined && parameterBillions < MIN_GOOD_BILLIONS) {
    return {
      fitness: 'marginal',
      parameterBillions,
      warning:
        `"${model}" is a ${parameterBillions}B model. It may manage simple edits but will ` +
        'struggle with multi-step tool use. A 7B coder model is markedly more reliable.',
    };
  }

  if (isCoder || isCapableGeneral) {
    return { fitness: 'good', parameterBillions };
  }

  // Unknown family at unknown or adequate size — don't cry wolf, but don't promise either.
  return {
    fitness: 'marginal',
    parameterBillions,
    warning:
      `"${model}" is not a model family known to handle tool calling well. If the agent ` +
      'replies in prose instead of using its tools, try qwen2.5-coder:7b.',
  };
}

/** Ranks candidates for the setup picker: best fit first, then larger, then by name. */
export function rankModels<T extends { name: string; parameterSize?: string }>(models: T[]): T[] {
  const order: Record<ToolCallingFitness, number> = { good: 0, marginal: 1, poor: 2 };
  return [...models].sort((a, b) => {
    const left = assessModel(a.name, a.parameterSize);
    const right = assessModel(b.name, b.parameterSize);
    if (order[left.fitness] !== order[right.fitness]) return order[left.fitness] - order[right.fitness];
    const sizeDelta = (right.parameterBillions ?? 0) - (left.parameterBillions ?? 0);
    if (sizeDelta !== 0) return sizeDelta;
    return a.name.localeCompare(b.name);
  });
}
