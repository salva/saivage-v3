import { redactForOutbound } from '../../redaction/index.js';
import { readAppLogEntries } from '../../persistence/app-log.js';

export interface DebugJsonlReadModel { errors?: unknown[]; events?: unknown[]; total: number; }

export class DebugReadModelService {
  constructor(private readonly projectRoot: string) {}

  getErrors(): DebugJsonlReadModel {
    const errors = readAppLogEntries(this.projectRoot, 'error').map((entry) => entry.data);
    const redactedErrors = errors.map((entry) => redactForOutbound(entry, 'operator.api', { source: 'debug-read-model.errors' }));
    return { errors: redactedErrors, total: redactedErrors.length };
  }

  getTimeline(): DebugJsonlReadModel {
    const events = readAppLogEntries(this.projectRoot, 'event').map((entry) => entry.data);
    const redactedEvents = events.map((entry) => redactForOutbound(entry, 'operator.api', { source: 'debug-read-model.timeline' }));
    return { events: redactedEvents, total: redactedEvents.length };
  }

}
