import { analystIssuesSchema, type AnalystIssue } from '../schemas/index.js';
import { sanitizeAnalystPayload } from './analyst-sanitization.js';

export function normalizeAnalystIssues(input: unknown): AnalystIssue[] {
  const parsed = analystIssuesSchema.parse(input);
  return parsed.map((issue) => sanitizeAnalystPayload(issue, 1000) as AnalystIssue);
}
