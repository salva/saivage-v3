import type {
  EntityLink,
  MessageKind,
  MessageRole,
} from '../schemas/index.js';
import type { SessionStamper } from '../runtime/session-stamper.js';
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
  constructor(private readonly saivageDir: string, private readonly stamper: SessionStamper) {}

  append(sessionId: string, message: MessageAppendInput) {
    const stamp =
      message.role === 'user'
        ? this.stamper.stampUserMessage(sessionId)
        : message.kind === 'model_issue' ||
            message.kind === 'model_repair' ||
            message.kind === 'context_compaction' ||
            message.kind === 'model_recovered'
          ? this.stamper.stampDiagnosticInCurrentRound(sessionId)
          : message.role === 'assistant' && message.kind === 'text'
            ? this.stamper.openAssistantRound(sessionId)
            : this.stamper.stampInRound(sessionId);
    return appendPersistentMessage(this.saivageDir, sessionId, message, stamp, this.stamper);
  }
}
