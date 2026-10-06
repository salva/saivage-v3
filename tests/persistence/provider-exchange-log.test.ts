import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { internalCompactionSummarySessionId, providerExchangeLogId } from '../../src/contracts/provider-exchange-log.js';
import { appendAppLogEntry, readAppLogEntries } from '../../src/persistence/app-log.js';
import type { ProviderExchangePayload } from '../../src/contracts/provider-exchange.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';
import { providerExchangeFile } from '../../src/persistence/layout.js';
import { appendProviderExchangeEntry, readLatestProviderExchangePayload, readProviderExchangeEntries } from '../../src/persistence/provider-exchange-log.js';

const roots: string[] = [];
const owner = 'agent:planner:project' as const;
const first = '2026-07-22T00:00:00.000Z';
const later = '2026-07-22T00:00:01.000Z';
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function project(initialized = true): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-evidence-'));
  roots.push(root);
  if (initialized) mkdirSync(dirname(providerExchangeFile(root, owner)), { recursive: true });
  return root;
}
function row(sessionId: string, model: string, timestamp = first, attemptIndex = 0, sourceInputId = model) {
  const payload: ProviderExchangePayload = {
    contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model,
    source_input_id: sourceInputId, attempt_index: attemptIndex, request_params: {}, started_at: timestamp,
    completed_at: timestamp, status: 'ok', terminal_tool_fired: null, assistant_output_ids: [],
  };
  return { type: 'provider_exchange' as const, data: { session_id: sessionId, source_input_id: sourceInputId, attempt_index: attemptIndex, timestamp, payload } };
}
function publish(root: string, sessionId: string, model: string, timestamp = first, attemptIndex = 0, sourceInputId = model): void {
  appendProviderExchangeEntry(root, owner, row(sessionId, model, timestamp, attemptIndex, sourceInputId));
}

describe('strict selected provider evidence', () => {
  it('retains partial/zero usage and summary facts without replacing latest primary', () => {
    const root = project();
    const primary = row(owner, 'primary');
    Object.assign(primary.data.payload, { token_usage: { cached_input_tokens: 0, reasoning_output_tokens: 5 } });
    appendProviderExchangeEntry(root, owner, primary);
    const summary = row(internalCompactionSummarySessionId(owner), 'summary', later);
    Object.assign(summary.data.payload, { token_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 40, reasoning_output_tokens: 5 } });
    appendProviderExchangeEntry(root, owner, summary);
    expect(readProviderExchangeEntries(root, owner)[1]!.data.payload).toEqual(summary.data.payload);
    expect(readLatestProviderExchangePayload(root, owner)).toEqual(primary.data.payload);
  });
  it.each([{ cached_input_tokens: -1 }, { reasoning_output_tokens: 0.5 }, { vendor_tokens: 1 }])('rejects malformed complete durable usage without rewriting %#', usage => {
    const root = project(); const entry = row(owner, 'bad');
    Object.assign(entry.data.payload, { token_usage: usage });
    const bytes = serializeGrowingEnvelope([entry]); const path = providerExchangeFile(root, owner);
    writeFileSync(path, bytes);
    expect(() => readProviderExchangeEntries(root, owner)).toThrow();
    expect(readFileSync(path)).toEqual(bytes);
  });
  it('truncates a valid torn prefix at read and append use, including interrupted multibyte bytes', () => {
    const root = project(); publish(root, owner, 'first'); const path = providerExchangeFile(root, owner); const prefix = readFileSync(path);
    writeFileSync(path, Buffer.concat([prefix, Buffer.from([0xe2, 0x82])]));
    expect(readLatestProviderExchangePayload(root, owner)?.model).toBe('first'); expect(readFileSync(path)).toEqual(prefix);
    writeFileSync(path, Buffer.concat([prefix, Buffer.from('suffix')])); publish(root, owner, 'second', later);
    expect(readProviderExchangeEntries(root, owner)).toHaveLength(2);
  });

  it.each(['duplicate', 'owner'] as const)('retains a semantically invalid %s prefix and its torn suffix at both uses', (fault) => {
    const root = project(); publish(root, owner, 'first'); const path = providerExchangeFile(root, owner);
    const invalid = row(fault === 'owner' ? 'agent:reviewer:project' : owner, 'first');
    writeFileSync(path, Buffer.concat([readFileSync(path), serializeGrowingEnvelope([invalid]), Buffer.from('suffix')])); const before = readFileSync(path);
    expect(() => readProviderExchangeEntries(root, owner)).toThrow();
    expect(() => publish(root, owner, 'later')).toThrow(); expect(readFileSync(path)).toEqual(before);
  });
  it('treats only missing exact evidence as empty; publication requires an existing owner', () => {
    const root = project();
    expect(readLatestProviderExchangePayload(root, owner)).toBeNull();
    publish(root, owner, 'first');
    publish(root, owner, 'second', later);
    expect(readProviderExchangeEntries(root, owner)).toHaveLength(2);
    const missing = project(false);
    expect(() => publish(missing, owner, 'failed')).toThrow();
    expect(existsSync(dirname(providerExchangeFile(missing, owner)))).toBe(false);
    expect(readLatestProviderExchangePayload(missing, owner)).toBeNull();
  });

  it('selects greatest timestamp, then attempt; ties retain first physical row and summaries never compete', () => {
    const root = project();
    publish(root, owner, 'old-high', first, 9);
    publish(root, owner, 'latest', later, 1);
    publish(root, owner, 'tie', later, 1);
    publish(root, internalCompactionSummarySessionId(owner), 'summary', later, 50);
    expect(readLatestProviderExchangePayload(root, owner)?.model).toBe('latest');
  });

  it('returns no ordinary latest for summary-only evidence and ignores unrelated sessions entirely', () => {
    const root = project();
    publish(root, internalCompactionSummarySessionId(owner), 'summary', later);
    expect(readLatestProviderExchangePayload(root, owner)).toBeNull();
    const unrelated = providerExchangeFile(root, 'agent:reviewer:project');
    mkdirSync(dirname(unrelated), { recursive: true });
    writeFileSync(unrelated, '{malformed}\n');
    publish(root, owner, 'early-target', first);
    publish(root, internalCompactionSummarySessionId(owner), 'late-summary', later);
    expect(readLatestProviderExchangePayload(root, owner)?.model).toBe('early-target');
  });

  it('does not certify logical IDs across distinct physical streams', () => {
    const root = project();
    const evidence = row(owner, 'exchange');
    publish(root, owner, 'exchange');
    const duplicateAcrossFiles = providerExchangeLogId(evidence.data);
    appendAppLogEntry(root, 'event', () => ({ type: 'event', data: { id: duplicateAcrossFiles, kind: 'runtime_diagnostic', timestamp: first, error_message: 'separate lane' } }));
    expect(readAppLogEntries(root, 'event')).toHaveLength(1);
    expect(readProviderExchangeEntries(root, owner)).toHaveLength(1);
  });

  it('validates the full selected file including early corruption, wrong owner/hash and duplicate identity without mutation', () => {
    for (const invalid of [row('agent:reviewer:project', 'wrong'), row(internalCompactionSummarySessionId('agent:reviewer:project'), 'wrong-summary')]) {
      const root = project();
      const path = providerExchangeFile(root, owner);
      writeFileSync(path, serializeGrowingEnvelope([invalid]));
      const before = readFileSync(path);
      expect(() => readLatestProviderExchangePayload(root, owner)).toThrow();
      expect(readFileSync(path)).toEqual(before);
    }
    const root = project();
    publish(root, owner, 'duplicate');
    publish(root, owner, 'duplicate');
    expect(() => readProviderExchangeEntries(root, owner)).toThrow(/duplicate logical id/);
    const path = providerExchangeFile(root, owner);
    writeFileSync(path, Buffer.from('{"version":1,"type":"rows","rows":[{"type":"event","data":{}}]}\n'));
    expect(() => readProviderExchangeEntries(root, owner)).toThrow(/malformed/);
    for (const bytes of [Buffer.alloc(0), Buffer.from('partial'), Buffer.from('{"version":2,"type":"rows","rows":[{}]}\n'), Buffer.from([0xff, 0x0a])]) {
      writeFileSync(path, bytes);
      expect(() => readProviderExchangeEntries(root, owner)).toThrow();
      expect(readFileSync(path)).toEqual(bytes);
    }
    writeFileSync(path, Buffer.concat([Buffer.from('{broken}\n'), ...Array.from({ length: 40 }, () => serializeGrowingEnvelope([row(owner, 'ok')]))]));
    expect(() => readProviderExchangeEntries(root, owner)).toThrow(/malformed/);
  });
});
