import { controlActionAuditEntrySchema, type ControlActionAuditEntry } from '../schemas/index.js';
import { redactTextForOutbound } from '../redaction/text.js';

export function projectControlAction(entry: ControlActionAuditEntry): ControlActionAuditEntry {
  const parsed = controlActionAuditEntrySchema.parse(entry);
  return controlActionAuditEntrySchema.parse({
    ...parsed,
    params_summary: redactTextForOutbound(parsed.params_summary),
    outcome_summary: redactTextForOutbound(parsed.outcome_summary),
    ...(parsed.error !== undefined ? { error: redactTextForOutbound(parsed.error) } : {}),
  });
}
