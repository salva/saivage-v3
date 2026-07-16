import type { AppLogContext } from '../../src/persistence/app-log.js';

const contexts = new Map<string, AppLogContext>();

export function testAppLogs(projectRoot: string): AppLogContext {
  const existing = contexts.get(projectRoot);
  if (existing) return existing;
  const context: AppLogContext = { projectRoot };
  contexts.set(projectRoot, context);
  return context;
}
