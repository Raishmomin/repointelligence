import { describe, expect, it } from 'vitest';
import { parseAgentEnvelope } from '../src/layer3-reasoning/agent/AgentProtocol';
import { classifyFileRisk, contentHash, isSafeCommand } from '../src/layer3-reasoning/agent/AgentSafety';

describe('agent protocol and safety boundaries', () => {
  it('accepts only recognised structured tool calls', () => {
    const parsed = parseAgentEnvelope('{"response":"ok","toolCalls":[{"id":"1","name":"read_file","arguments":{"path":"src/a.ts"}},{"id":"2","name":"shell","arguments":{}}]}');
    expect(parsed.response).toBe('ok');
    expect(parsed.toolCalls).toHaveLength(1);
  });
  it('degrades malformed model JSON to a text-only response', () => expect(parseAgentEnvelope('not json')).toEqual({ response: 'not json' }));
  it('classifies risky file operations', () => {
    expect(classifyFileRisk('delete', 'src/a.ts')).toBe('high');
    expect(classifyFileRisk('edit', '.env')).toBe('high');
    expect(classifyFileRisk('edit', 'package.json')).toBe('medium');
  });
  it('rejects shell metacharacters and produces stable content hashes', () => {
    expect(isSafeCommand('npm', ['test'])).toBe(true);
    expect(isSafeCommand('sh -c', ['echo x'])).toBe(false);
    expect(contentHash('before')).not.toBe(contentHash('after'));
  });
});
