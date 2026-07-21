import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('EventQueryService', () => {
  it('defaults to oldest 50 and returns a chronological newest tail', () => {
    const root = mkdtempSync(join(tmpdir(), 'event-query-')); roots.push(root);
    for (let index = 0; index < 55; index++) appendAppLogEntry(root, 'event', () => ({ type: 'event', data: { kind: 'runtime_diagnostic', id: `evt-${index}`, timestamp: new Date(index).toISOString(), error_message: `failure ${index}`, card_id: index % 2 ? 'card-a' : 'project' } }));
    const service = new EventQueryService(root);
    expect(service.queryEvents()).toMatchObject({ total: 55, events: expect.arrayContaining([expect.objectContaining({ id: 'evt-0' })]) });
    expect(service.queryEvents().events).toHaveLength(50);
    expect(service.queryEvents({ selection: 'newest_tail', limit: 3 }).events.map(({ id }) => id)).toEqual(['evt-52', 'evt-53', 'evt-54']);
    expect(service.queryEvents({ card_id: 'card-a', limit: 100 }).total).toBe(27);
  });

  it('enforces maximum, offset, and newest-tail contracts and derives errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'event-query-')); roots.push(root);
    appendAppLogEntry(root, 'event', () => ({ type: 'event', data: { kind: 'mcp_tool_invocation', id: 'ok', timestamp: new Date(0).toISOString(), server: 's', tool: 't', success: true, duration_ms: 1 } }));
    appendAppLogEntry(root, 'event', () => ({ type: 'event', data: { kind: 'mcp_tool_invocation', id: 'failed', timestamp: new Date(1).toISOString(), server: 's', tool: 't', success: false, duration_ms: 1, error: 'failed' } }));
    const service = new EventQueryService(root);
    expect(() => service.queryEvents({ limit: 1001 })).toThrow(/1000/);
    expect(() => service.queryEvents({ selection: 'newest_tail', offset: 1 })).toThrow(/nonzero offset/);
    expect(service.queryErrors()).toEqual({ total: 1, errors: [expect.objectContaining({ id: 'failed' })] });
  });
});
