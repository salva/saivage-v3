import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ProviderExchangePayload } from '../../src/contracts/provider-exchange.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import {
  readLatestProviderExchangePayload,
  readLatestProviderExchangePayloadMap,
} from '../../src/persistence/provider-exchange-log.js';

const roots: string[] = [];
const firstTimestamp = '2026-07-22T00:00:00.000Z';
const laterTimestamp = '2026-07-22T00:00:01.000Z';

afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('latest provider-exchange selection', () => {
  it('returns an empty map for a missing or empty lane', () => {
    const missing = project();
    expect([...readLatestProviderExchangePayloadMap(missing)]).toEqual([]);

    const empty = project();
    appendAppLogEntry(empty, 'event', () => ({
      type: 'event',
      data: { kind: 'runtime_diagnostic', id: 'unrelated-event', timestamp: firstTimestamp, error_message: 'unrelated' },
    }));
    expect([...readLatestProviderExchangePayloadMap(empty)]).toEqual([]);
  });

  it('selects independently for every exact key by timestamp and then attempt index', () => {
    const root = project();
    publish(root, 'agent:planner:project', 'planner-old', firstTimestamp, 9);
    publish(root, 'summary:project', 'summary', firstTimestamp, 0);
    publish(root, 'agent:planner:project', 'planner-later-low-attempt', laterTimestamp, 0);
    publish(root, 'agent:reviewer:project', 'reviewer-low-attempt', firstTimestamp, 0);
    publish(root, 'agent:reviewer:project', 'reviewer-high-attempt', firstTimestamp, 2);

    const latest = readLatestProviderExchangePayloadMap(root);
    expect(latest.get('agent:planner:project')?.model).toBe('planner-later-low-attempt');
    expect(latest.get('agent:reviewer:project')?.model).toBe('reviewer-high-attempt');
    expect(latest.get('summary:project')?.model).toBe('summary');
  });

  it('retains the earlier physical row on an exact comparator tie and singular lookup delegates to it', () => {
    const root = project();
    publish(root, 'agent:planner:project', 'physical-first', firstTimestamp, 1, 'source-first');
    publish(root, 'agent:planner:project', 'physical-second', firstTimestamp, 1, 'source-second');

    expect(readLatestProviderExchangePayloadMap(root).get('agent:planner:project')?.model).toBe('physical-first');
    expect(readLatestProviderExchangePayload(root, 'agent:planner:project')?.model).toBe('physical-first');
    expect(readLatestProviderExchangePayload(root, 'agent:reviewer:project')).toBeNull();
  });

  it('fails the complete read when any canonical app-log envelope is malformed', () => {
    const root = project();
    mkdirSync(dirname(appLogFile(root)), { recursive: true });
    writeFileSync(appLogFile(root), '{"version":1,"type":"rows","rows":[{"invalid":true}]}\n');
    expect(() => readLatestProviderExchangePayloadMap(root)).toThrow(/malformed/);
  });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-provider-exchange-latest-'));
  roots.push(root);
  return root;
}

function publish(root: string, sessionId: string, model: string, timestamp: string, attemptIndex: number, sourceInputId = `${sessionId}-${model}`): void {
  const payload: ProviderExchangePayload = {
    contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model,
    source_input_id: sourceInputId, attempt_index: attemptIndex, request_params: {}, started_at: timestamp,
    completed_at: timestamp, status: 'ok', terminal_tool_fired: null, assistant_output_ids: [],
  };
  appendAppLogEntry(root, 'provider_exchange', () => ({
    type: 'provider_exchange',
    data: { session_id: sessionId, source_input_id: sourceInputId, attempt_index: attemptIndex, timestamp, payload },
  }));
}
