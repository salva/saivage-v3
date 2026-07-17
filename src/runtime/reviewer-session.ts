import { ReviewerConversationSessionIdSchema, type ReviewerConversationSessionId } from '../schemas/index.js';

export function reviewerSessionId(goalId: string): ReviewerConversationSessionId {
  return ReviewerConversationSessionIdSchema.parse(`reviewer:${goalId}`);
}
