import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { processToolBinders, type ProcessProviderContext } from '../../src/tools/process-provider.js';
import { globalObservationToolBinders, type GlobalObservationToolContext } from '../../src/tools/global-observation-tools.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { buildProcessView } from '../../src/application/read-models/process-view.js';
import { appendConversationBatch, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { cardConversationVersionFile } from '../../src/persistence/layout.js';
import { composeContextProjection, providerConversationFromComposedContext } from '../../src/runtime/actors/context/composition-projector.js';
import { agentMessageSchema, canonicalJson, sha256Hex } from '../../src/schemas/index.js';
import { ProcessToolResultSchema } from '../../src/contracts/index.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { SyntheticProcessPlatform } from '../helpers/synthetic-process-platform.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import type { CollectionPage, CollectionPosition } from '../../src/tools/response-packer.js';

const fixtures: Array<{ root: string; platform: SyntheticProcessPlatform }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.platform.destroy(); rmSync(f.root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'unavailable-observations-'));
  initProjectTree(root);
  const platform = new SyntheticProcessPlatform();
  const registry = new ManagedProcessGroupRegistry(platform);
  const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
  const scope = registry.createDirectScope(registry.rootScope, 'original', 'runtime_card');
  const ctx: ProcessProviderContext = { projectRoot: root, processRunner: runner, directScope: scope, category: 'runtime_card', ownerId: 'original', ownerKind: 'agent', cardId: 'project' };
  const lose = async () => {
    platform.probe = pgid => { platform.operations.push(`probe:${pgid}`); throw Object.assign(new Error('EPERM token=synthetic-group-secret'), { code: 'EPERM' }); };
    return runner.closeAndTerminateDirectScope({ directScope: scope, category: 'runtime_card', reason: 'test', graceMs: 0 });
  };
  const f = { root, platform, registry, runner, scope, ctx, lose };
  fixtures.push(f); return f;
}
async function command(f: ReturnType<typeof fixture>, name: string, args: unknown, ctx = f.ctx) {
  return (await processToolBinders.find(b => b.name === name)!.bind(ctx).executor(args, new AbortController().signal)).providerOutcome;
}
async function observe(f: ReturnType<typeof fixture>, name: string, args: unknown) {
  const ctx = { projectRoot: f.root, processRunner: f.runner, runtime: { getStatus: () => ({ status: 'stopped', currentCardId: null }) }, store: { list: () => [] } } as unknown as GlobalObservationToolContext;
  return settleToolActionOutcome((await globalObservationToolBinders.find(b => b.name === name)!.bind(ctx).executor(args, new AbortController().signal)).providerOutcome).providerResult;
}

describe('actual command and retained process observation owners', () => {
  it.each(['run_command', 'wait_process'])('fails entered %s without auto-kill and denies later ownership', async name => {
    const f = fixture();
    if (name === 'wait_process') await command(f, 'run_command', { command: 'synthetic', wait: false });
    const pending = command(f, name, name === 'run_command' ? { command: 'synthetic', timeout_ms: 30 } : { process_id: f.runner.list()[0]!.id, timeout_ms: 30 });
    const record = f.runner.list()[0]!;
    const kill = jest.spyOn(f.runner, 'kill');
    await f.lose();
    const result = await pending;
    expect(result).toMatchObject({ kind: 'failed', error: expect.stringContaining('cleanup/exit evidence unavailable') });
    expect(result).not.toHaveProperty('data');
    expect(JSON.stringify(result)).toContain(record.id);
    expect(JSON.stringify(result)).not.toContain('synthetic-group-secret');
    expect(kill).not.toHaveBeenCalled();
    const later = { ...f.ctx, ownerId: 'later', directScope: f.registry.createDirectScope(f.registry.rootScope, 'later', 'runtime_card') };
    expect(await command(f, 'wait_process', { process_id: record.id, timeout_ms: 0 }, later)).toMatchObject({ kind: 'failed', error: expect.stringContaining('not owned') });
    expect(await command(f, 'kill_process', { process_id: record.id }, later)).toMatchObject({ kind: 'failed', error: expect.stringContaining('not owned') });
    expect(kill).not.toHaveBeenCalled();
    expect(await command(f, 'kill_process', { process_id: record.id })).toMatchObject({ kind: 'failed', error: expect.stringContaining('evidence unavailable') });
    expect(await command(f, 'wait_process', { process_id: record.id, timeout_ms: 0 })).toMatchObject({ kind: 'failed', error: expect.stringContaining('evidence unavailable') });
    expect(f.platform.operations).toHaveLength(1);
    expect(f.runner.get(record.id)?.status).toBe('unavailable');
  });

  it('shares API projection, bounds/redacts list packing, and retains old/new observations through canonical/current-primary readers', async () => {
    const f = fixture();
    await command(f, 'run_command', { command: 'synthetic', wait: false });
    const child = f.platform.children[0]!;
    child.stdout.emit('error', new Error('token=synthetic-stream-secret ' + 'x'.repeat(4000)));
    child.emit('error', new Error('token=synthetic-leader-secret'));
    child.emit('exit', 1, null);
    await f.lose();
    const record = f.runner.list()[0]!;
    const api = buildProcessView(f.root, record);
    const observed = await observe(f, 'list_processes_tool', {});
    const filtered = await observe(f, 'list_processes_tool', { status: 'unavailable' });
    expect(filtered).toEqual(observed);
    if (!observed.success) throw new Error(observed.error);
    expect(observed.data).toMatchObject({ processes: { total: 1, returned: 1, items: [api] } });
    for (const bytes of [512, 1024, 32768]) {
      const packed = await observe(f, 'list_processes_tool', { response_bytes: bytes });
      const content = canonicalJson(packed);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(bytes);
      expect(content).not.toMatch(/synthetic-(?:group|leader|stream)-secret/);
      expect(packed.success).toBe(true);
    }
    let position: CollectionPosition | null = { item_index: 0, item_byte_offset: 0 };
    const slices: Buffer[] = [];
    while (position) {
      const packed = await observe(f, 'list_processes_tool', { response_bytes: 512, position });
      if (!packed.success) throw new Error(packed.error);
      expect(Buffer.byteLength(canonicalJson(packed))).toBeLessThanOrEqual(512);
      const page = (packed.data as { processes: CollectionPage }).processes;
      expect(page.position).toEqual(position);
      const slice = page.items[0] as { content_hex: string; offset_bytes: number; next_offset_bytes: number };
      const bytes = Buffer.from(slice.content_hex, 'hex');
      expect(bytes.toString()).not.toMatch(/synthetic-(?:group|leader|stream)-secret/);
      expect(slice.offset_bytes).toBe(slices.reduce((total, slice) => total + slice.length, 0));
      slices.push(bytes);
      if (page.next) expect(page.next.item_byte_offset).toBeGreaterThan(position.item_byte_offset);
      position = page.next;
    }
    expect(JSON.parse(Buffer.concat(slices).toString())).toEqual(api);
    const status = await observe(f, 'get_status', {});
    expect(status).toMatchObject({ success: true, data: { runningProcesses: 0 } });
    expect(f.platform.operations).toHaveLength(1);

    const { evidence: _evidence, ...priorShape } = api;
    const old = { success: true, data: { processes: { total: 1, returned: 1, items: [{ ...priorShape, status: 'running' }] } } };
    for (const [index, envelope] of [old, observed].entries()) {
      const content = canonicalJson(envelope);
      const callId = `list-${index}`;
      const policies = toolRowPolicies({ content, template: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, evidence: { kind: 'observational_query', observedSha256: sha256Hex(content) } });
      const common = { session_id: 'agent:planner:project', timestamp: '2026-10-09T00:00:00.000Z', round_id: `r-pre-${String(index + 1).padStart(32, '0')}`, message_index: 0, block_index: 0, tool: 'list_processes_tool', tool_call_id: callId };
      const inputId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const rows = [agentMessageSchema.parse({ ...common, id: `${inputId}:tool-call:${callId}`, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'list_processes_tool', arguments: '{}' } }] }), context_policy: policies.call }), agentMessageSchema.parse({ ...common, id: `${inputId}:tool-result:${callId}`, role: 'tool', kind: 'tool_result', content, context_policy: policies.result })];
      appendConversationBatch({ projectRoot: f.root }, rows);
      const segment = readCurrentConversationSegment(f.root, 'agent:planner:project')!;
      const path = cardConversationVersionFile(f.root, 'project', 'planner', segment.entry.filename);
      const bytes = readFileSync(path);
      const projection = composeContextProjection({ sourceSessionId: 'agent:planner:project', effectiveHistory: null, dynamicBlocks: [], uncoveredRows: segment.conversation.sourceRows });
      expect(projection.primary.filter(entry => entry.origin === 'canonical').map(entry => entry.origin === 'canonical' ? entry.row : null)).toContainEqual(rows[1]);
      expect(providerConversationFromComposedContext(projection).messages).toContainEqual(rows[1]);
      expect(readCurrentConversationSegment(f.root, 'agent:planner:project')!.rows).toContainEqual(rows[1]);
      expect(readFileSync(path)).toEqual(bytes);
      if (index === 0) expect(rows[1]!.content).not.toContain('evidence');
    }
    const successfulCommand = { process_id: record.id, status: 'running', exit_code: null, stdout: '', stderr: '', stdout_complete: true, stderr_complete: true, stdout_bytes: 0, stderr_bytes: 0, stdout_url: api.logs.stdout, stderr_url: api.logs.stderr };
    expect(ProcessToolResultSchema.safeParse(successfulCommand).success).toBe(true);
    expect(ProcessToolResultSchema.safeParse({ ...successfulCommand, status: 'unavailable' }).success).toBe(false);
    const content = canonicalJson({ success: true, data: { ...successfulCommand, status: 'unavailable' } });
    const policies = toolRowPolicies({ content, template: OPERATIONAL_RESULT_POLICY_TEMPLATE });
    const common = { session_id: 'agent:planner:project', timestamp: '2026-10-09T00:00:00.000Z', round_id: `r-pre-${'3'.padStart(32, '0')}`, message_index: 0, block_index: 0, tool: 'run_command', tool_call_id: 'command' };
    const call = agentMessageSchema.parse({ ...common, id: '00000000-0000-4000-8000-000000000003:tool-call:command', role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'command', type: 'function', function: { name: 'run_command', arguments: '{}' } }] }), context_policy: policies.call });
    const result = agentMessageSchema.parse({ ...common, id: '00000000-0000-4000-8000-000000000003:tool-result:command', role: 'tool', kind: 'tool_result', content, context_policy: policies.result });
    const compose = (rows: typeof call[]) => providerConversationFromComposedContext(composeContextProjection({ sourceSessionId: 'agent:planner:project', effectiveHistory: null, dynamicBlocks: [], uncoveredRows: rows }));
    expect(() => compose([call, result])).toThrow();
    const validContent = canonicalJson({ success: true, data: successfulCommand });
    const validResult = { ...result, content: validContent, context_policy: toolRowPolicies({ content: validContent, template: OPERATIONAL_RESULT_POLICY_TEMPLATE }).result };
    expect(compose([call, validResult]).messages).toContainEqual(validResult);
  });

  it('command failures show actual EOF/open/closed independently from capture failure without consuming the entry', async () => {
    const f = fixture();
    await command(f, 'run_command', { command: 'synthetic', wait: false });
    const child = f.platform.children[0]!;
    child.stdout.emit('error', new Error('stdout capture failed'));
    child.stderr.emit('error', new Error('stderr capture failed'));
    await f.lose();
    const id = f.runner.list()[0]!.id;
    let result = await command(f, 'wait_process', { process_id: id, timeout_ms: 0 });
    expect(result).toMatchObject({ kind: 'failed', error: expect.stringContaining('stdout=open, stderr=open') });
    expect(result).toMatchObject({ error: expect.stringContaining('stdout capture=stdout capture failed; stderr capture=stderr capture failed') });
    child.stdout.end();
    child.stderr.destroy();
    await new Promise<void>(resolve => setImmediate(resolve));
    child.stdout.destroy();
    child.emit('exit', 1, null);
    result = await command(f, 'wait_process', { process_id: id, timeout_ms: 0 });
    expect(result).toMatchObject({ kind: 'failed', error: expect.stringContaining('stdout=eof, stderr=closed') });
    expect(result).toMatchObject({ error: expect.stringContaining('stdout capture=stdout capture failed; stderr capture=stderr capture failed') });
    expect(result).toMatchObject({ error: expect.stringContaining('Leader exit: exit=1, signal=null') });
    expect(f.runner.get(id)?.completed_at).toBeNull();
    expect(f.platform.operations).toHaveLength(1);
  });
});
