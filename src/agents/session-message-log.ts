import type {
  EntityLink,
  MessageKind,
  MessageRole,
} from '../schemas/index.js';
import { generateRoundId } from '../schemas/round-id-server.js';
import type { RoundStamp } from '../runtime/session-stamper.js';
import { appendMessage as appendPersistentMessage } from './session-persistence.js';

export interface MessageAppendInput {
  role: MessageRole;
  kind: MessageKind;
  content: string;
  tool?: string;
  tool_call_id?: string;
  links?: EntityLink[];
  model_spec?: string;
  requested_model_spec?: string;
}

export class SessionMessageLog {
  private readonly fallbackCurrentRoundId = new Map<string, string>();
  private readonly fallbackBlockCounters = new Map<string, number>();

  constructor(private readonly saivageDir: string) {}

  nextFallbackRound(
    sessionId: string,
    prefix: 'pre' | 'user' | 'assistant' | 'diagnostic' = 'assistant',
  ): RoundStamp {
    const id = generateRoundId(prefix);
    this.fallbackCurrentRoundId.set(sessionId, id);
    if (prefix !== 'assistant') this.fallbackBlockCounters.set(sessionId, 0);
    return { round_id: id, message_index: 0, block_index: 0 };
  }

  stampInCurrentFallbackRound(sessionId: string): RoundStamp {
    let current = this.fallbackCurrentRoundId.get(sessionId);
    if (!current) {
      current = generateRoundId('assistant');
      this.fallbackCurrentRoundId.set(sessionId, current);
    }
    const block = this.fallbackBlockCounters.get(sessionId) ?? 0;
    this.fallbackBlockCounters.set(sessionId, block + 1);
    return { round_id: current, message_index: block, block_index: block };
  }

  append(sessionId: string, message: MessageAppendInput) {
    const stamp =
      message.role === 'user'
        ? this.nextFallbackRound(sessionId, 'user')
        : message.kind === 'model_issue' ||
            message.kind === 'model_repair' ||
            message.kind === 'context_compaction' ||
            message.kind === 'model_recovered'
          ? this.nextFallbackRound(sessionId, 'diagnostic')
          : message.role === 'assistant' && message.kind === 'text'
            ? this.nextFallbackRound(sessionId, 'assistant')
            : this.stampInCurrentFallbackRound(sessionId);
    return appendPersistentMessage(this.saivageDir, sessionId, message, stamp);
  }
}
