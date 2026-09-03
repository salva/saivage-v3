import type { ConversationSessionId } from '../schemas/index.js';
import type { ToolResult } from './tool-result.js';

export interface InvocationIdentity {
  readonly sessionId: ConversationSessionId;
  readonly sourceInputId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface CanonicalCallIdentity extends InvocationIdentity {
  readonly startedAt: string;
}

export type CanonicalResultIdentity = InvocationIdentity;

export type ToolInvocationProjectionInput =
  | {
      readonly shape: 'complete';
      readonly identity: InvocationIdentity;
      readonly arguments: unknown;
      readonly result: ToolResult;
    }
  | {
      readonly shape: 'call-row';
      readonly identity: CanonicalCallIdentity;
      readonly arguments: string;
      readonly result?: never;
    }
  | {
      readonly shape: 'result-row';
      readonly identity: CanonicalResultIdentity;
      readonly result: ToolResult;
      readonly arguments?: never;
    };

export type ToolInvocationProjector = (input: ToolInvocationProjectionInput) => ToolInvocationProjectionInput;
