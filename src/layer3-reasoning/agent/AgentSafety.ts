import * as crypto from 'crypto';
import { RiskLevel } from '../../shared/types/agent.types';

export const contentHash = (content: string): string => crypto.createHash('sha256').update(content).digest('hex');
export function classifyFileRisk(kind: string, file: string): RiskLevel {
  if (kind === 'delete' || kind === 'rename' || /(^|\/)(\.env|.*secret|.*credential)/i.test(file)) return 'high';
  if (/package\.json|lock$|\.config\./i.test(file)) return 'medium';
  return 'low';
}
export function isSafeCommand(command: string, args: string[]): boolean {
  // Spawn receives the executable separately from arguments: it must be a single literal name/path segment.
  return /^[A-Za-z0-9._-]+$/.test(command) && !args.some(arg => /[\n\0]/.test(arg));
}
