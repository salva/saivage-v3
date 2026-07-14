import { EventLogger as ProductionEventLogger, ErrorLogger as ProductionErrorLogger } from '../../src/observability/index.js';
import { EventBus } from '../../src/events/index.js';
import { testAppLogs } from './app-logs.js';

function projectRoot(path: string): string { return path.endsWith('/.saivage') ? path.slice(0, -'/.saivage'.length) : path; }

export class TestEventLogger extends ProductionEventLogger {
  constructor(path: string, eventBus = new EventBus()) { const root = projectRoot(path); super(root, testAppLogs(root), eventBus); }
}

export class TestErrorLogger extends ProductionErrorLogger {
  constructor(path: string, eventBus = new EventBus()) { const root = projectRoot(path); super(root, testAppLogs(root), eventBus); }
}
