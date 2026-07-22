import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalystSession } from '../../src/agents/analyst-handler.js';
import { createEventLog } from '../../src/observability/index.js';
import { AppLogPublicationError, readAppLogEntries } from '../../src/persistence/app-log.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function session(projectRoot: string, eventLogger: ReturnType<typeof createEventLog>): AnalystSession {
  return new AnalystSession({
    projectRoot, sessionId: 'agent:analyst:global', config: {}, candidateChain: [], promptTemplates: {}, restartServerAvailable: false,
    provider: {}, conversations: { projectRoot }, compactionPolicy: {}, compactor: {}, summarizerProvider: {}, eventLogger, cardStore: {},
    runtimeProjectionChanged() {}, createInvocationSurface() { throw new Error('unused'); }, async shutdownProcesses() {},
  } as never);
}
function publishDiagnostic(value: AnalystSession, phase: string, error: unknown): void {
  (value as unknown as { logBoundaryDiagnostic(phase: string, error: unknown): void }).logBoundaryDiagnostic(phase, error);
}

describe('Analyst boundary diagnostics', () => {
  it('mandatorily appends the diagnostic before issuing its timeline hint', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-diagnostic-')); roots.push(projectRoot);
    const trace: string[] = [];
    const value = session(projectRoot, createEventLog(projectRoot, () => trace.push('hint')));
    publishDiagnostic(value, 'project_context_failed', new Error('secret token=value'));
    const events = readAppLogEntries(projectRoot, 'event').map((entry) => entry.data);
    expect(events).toEqual([
      expect.objectContaining({ kind: 'runtime_diagnostic', phase: 'project_context_failed', error_message: expect.any(String) }),
    ]);
    expect(JSON.stringify(events)).not.toContain('token=value');
    expect(trace).toEqual(['hint']);
  });

  it('propagates publication failure with the diagnosed error as operation context and issues no hint', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-diagnostic-')); roots.push(projectRoot);
    writeFileSync(join(projectRoot, '.saivage'), 'not a directory');
    const hints: string[] = []; const diagnosed = new Error('diagnosed');
    const value = session(projectRoot, createEventLog(projectRoot, () => hints.push('hint')));
    let thrown: unknown;
    try { publishDiagnostic(value, 'protocol_failed', diagnosed); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AppLogPublicationError);
    expect(thrown).toMatchObject({ entryType: 'event', operationError: diagnosed });
    expect(hints).toEqual([]);
  });
});
