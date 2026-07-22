import { z } from 'zod';

import type { ConversationSessionId } from '../schemas/index.js';

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

export const ToolInvocationResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: z.unknown().optional() }).strict(),
  z.object({ success: z.literal(false), error: z.string(), data: z.unknown().optional() }).strict(),
]);

export type ToolInvocationResult = z.infer<typeof ToolInvocationResultSchema>;

export type ToolInvocationProjectionInput =
  | {
      readonly shape: 'complete';
      readonly identity: InvocationIdentity;
      readonly arguments: unknown;
      readonly result: ToolInvocationResult;
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
      readonly result: ToolInvocationResult;
      readonly arguments?: never;
    };

export type ToolInvocationProjector = (input: ToolInvocationProjectionInput) => ToolInvocationProjectionInput;
