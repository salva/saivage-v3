import { redactForOutbound } from '../../redaction/index.js';
import { readAppLogEntries } from '../../persistence/app-log.js';
import { DebugErrorsResponseSchema, DebugTimelineResponseSchema, type DebugErrorsResponse, type DebugTimelineResponse } from '../../contracts/index.js';

export class DebugReadModelService {
  constructor(private readonly projectRoot: string) {}

  getErrors(): DebugErrorsResponse {
    const errors = readAppLogEntries(this.projectRoot, 'error').map((entry) => entry.data);
    const redactedErrors = errors.map((entry) => redactForOutbound(entry));
    return DebugErrorsResponseSchema.parse({ errors: redactedErrors, total: redactedErrors.length });
  }

  getTimeline(): DebugTimelineResponse {
    const events = readAppLogEntries(this.projectRoot, 'event').map((entry) => entry.data);
    const redactedEvents = events.map((entry) => redactForOutbound(entry));
    return DebugTimelineResponseSchema.parse({ events: redactedEvents, total: redactedEvents.length });
  }

}
