import { LlmMessage } from '../providers/types';

/**
 * Holds the conversation for one agent run and keeps it inside the context window.
 *
 * The hard invariant everything here protects: an assistant turn containing `tool_use`
 * blocks must be immediately followed by the user turn answering them. Dropping either
 * half leaves an unanswered tool call, which the API rejects outright — so compaction
 * always removes matched pairs, never a lone message.
 */
export class TranscriptManager {
  private messages: LlmMessage[] = [];

  constructor(private readonly contextWindow: number) {}

  get length(): number {
    return this.messages.length;
  }

  all(): LlmMessage[] {
    return this.messages;
  }

  push(message: LlmMessage): void {
    this.messages.push(message);
  }

  replaceAll(messages: LlmMessage[]): void {
    this.messages = [...messages];
  }

  /**
   * Rough token estimate from character count. Deliberately crude: it only decides *when*
   * to compact, and a provider's exact count would cost a network round trip per turn.
   * Four characters per token is the usual English/code approximation.
   */
  estimatedTokens(): number {
    let characters = 0;
    for (const message of this.messages) {
      if (typeof message.content === 'string') {
        characters += message.content.length;
        continue;
      }
      for (const block of message.content) {
        if ('text' in block && typeof block.text === 'string') characters += block.text.length;
        else if ('content' in block && typeof block.content === 'string') characters += block.content.length;
        else if ('input' in block) characters += JSON.stringify(block.input).length;
      }
    }
    return Math.ceil(characters / 4);
  }

  /** Compaction threshold: leave room for the next turn plus its output. */
  shouldCompact(): boolean {
    return this.estimatedTokens() > this.contextWindow * 0.7;
  }

  /**
   * Drops the oldest complete exchanges, keeping the opening user turn (which carries the
   * task) and the most recent turns (which carry the working state).
   *
   * Returns the number of messages removed. Used only on the Ollama path — the Anthropic
   * path prefers server-side compaction, which summarises rather than discards.
   */
  compact(keepRecent = 6): number {
    // 1 opening turn + a meaningful tail; below this there is nothing safe to drop.
    if (this.messages.length <= keepRecent + 2) return 0;

    const head = this.messages.slice(0, 1);
    const tailStart = findPairSafeBoundary(this.messages, this.messages.length - keepRecent);
    const tail = this.messages.slice(tailStart);
    const removed = this.messages.length - head.length - tail.length;
    if (removed <= 0) return 0;

    const notice: LlmMessage = {
      role: 'user',
      content:
        `[${removed} earlier messages were removed to stay within the context window. ` +
        `Files you read before that point may no longer be in view — read them again ` +
        `rather than relying on memory of their contents.]`,
    };

    this.messages = [...head, notice, ...tail];
    return removed;
  }
}

/**
 * Moves a proposed cut point later until it does not split a tool_use turn from the
 * tool_result turn answering it. Cutting between them would leave the surviving assistant
 * turn's tool calls unanswered.
 */
function findPairSafeBoundary(messages: LlmMessage[], proposed: number): number {
  let boundary = Math.max(0, Math.min(proposed, messages.length));

  while (boundary < messages.length) {
    const message = messages[boundary];
    const isOrphanedResults =
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result');

    if (!isOrphanedResults) break;
    // This user turn answers an assistant turn we would have dropped; skip past it.
    boundary++;
  }

  return boundary;
}
