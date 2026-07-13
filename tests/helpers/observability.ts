import { EventLogger as ProductionEventLogger, ErrorLogger as ProductionErrorLogger, type AppendEventInput, type ErrorInput } from '../../src/observability/index.js';
import { EventBus } from '../../src/events/index.js';
import { testAppLogAuthority, testAppLogs } from './app-logs.js';
import type { MutationAuthority } from '../../src/application/mutation-authority.js';

function projectRoot(path: string): string { return path.endsWith('/.saivage') ? path.slice(0, -'/.saivage'.length) : path; }

export class TestEventLogger extends ProductionEventLogger {
  readonly #root: string;
  constructor(path: string, eventBus = new EventBus()) { const root = projectRoot(path); super(root, testAppLogs(root), eventBus); this.#root = root; }
  appendEvent(event: AppendEventInput): ReturnType<ProductionEventLogger['appendEvent']>;
  appendEvent(authority: MutationAuthority, event: AppendEventInput): ReturnType<ProductionEventLogger['appendEvent']>;
  appendEvent(authorityOrEvent: MutationAuthority | AppendEventInput, event?: AppendEventInput) { return event ? super.appendEvent(authorityOrEvent as MutationAuthority, event) : super.appendEvent(testAppLogAuthority(this.#root), authorityOrEvent as AppendEventInput); }
}

export class TestErrorLogger extends ProductionErrorLogger {
  readonly #root: string;
  constructor(path: string, eventBus = new EventBus()) { const root = projectRoot(path); super(root, testAppLogs(root), eventBus); this.#root = root; }
  appendError(error: ErrorInput): ReturnType<ProductionErrorLogger['appendError']>;
  appendError(authority: MutationAuthority, error: ErrorInput): ReturnType<ProductionErrorLogger['appendError']>;
  appendError(authorityOrError: MutationAuthority | ErrorInput, error?: ErrorInput) { return error ? super.appendError(authorityOrError as MutationAuthority, error) : super.appendError(testAppLogAuthority(this.#root), authorityOrError as ErrorInput); }
}
