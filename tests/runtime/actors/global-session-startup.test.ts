import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { settleFinalUnmatchedCall } from '../../../src/runtime/runtime-api.js';
import { appendConversationBatch, initializeMissingConversation, readConversation, readCurrentConversationSegment } from '../../../src/persistence/conversation-file.js';
import { globalAgentConversationVersionFile, globalAgentConversationVersionIndexFile } from '../../../src/persistence/layout.js';
import { buildGlobalAgentIngressRows } from '../../../src/runtime/actors/conversation-session.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { toolCallRowPolicy } from '../../helpers/row-policy-fixtures.js';
import { appendStartupPendingCall } from '../../helpers/startup-session-fixtures.js';

const SESSION = 'agent:analyst:global' as const;
const OVERSIGHT_SESSION = 'agent:oversight:global' as const;
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function stabilize(root: string, sessionId: typeof SESSION | typeof OVERSIGHT_SESSION): void {
  settleFinalUnmatchedCall({ projectRoot: root }, sessionId);
}

describe('configured global fresh-startup settlement', () => {
  it('accepts a configured empty catalog without publication', () => {
    const root = projectRoot();
    expect(readCurrentConversationSegment(root, SESSION)).toBeNull();
    stabilize(root, SESSION);
    expect(readCurrentConversationSegment(root, SESSION)).toBeNull();
  });

  it('byte-preserves valid current conversation data', () => {
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); const before = readFileSync(path);
    stabilize(root, SESSION);
    expect(readFileSync(path)).toEqual(before);
  });

  it('admits retained ordinary system text beside later two-row ingress without rewriting it', () => {
    const root = projectRoot();
    const old = buildGlobalAgentIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'old question');
    const retained = { ...old[1], id: `${SESSION}:retained-note`, role: 'system' as const, content: '[workspace-context] view: cockpit', round_id: old[0].round_id, message_index: 0, block_index: 1 };
    appendConversationBatch({ projectRoot: root }, [old[0], retained, old[1]]);
    appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(SESSION, '22222222-2222-4222-8222-222222222222', 'new question'));
    const segment = readCurrentConversationSegment(root, SESSION)!;
    const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    const before = readFileSync(path);
    expect(readConversation(root, SESSION).sourceRows.map((row) => row.content)).toContain(retained.content);
    stabilize(root, SESSION);
    expect(readFileSync(path)).toEqual(before);
  });

  it('rejects malformed marker content and marker-free system-text preambles without editing either', () => {
    const malformedRoot = projectRoot();
    const ingress = buildGlobalAgentIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'question');
    appendConversationBatch({ projectRoot: malformedRoot }, ingress);
    const malformedSegment = readCurrentConversationSegment(malformedRoot, SESSION)!;
    const malformedPath = globalAgentConversationVersionFile(malformedRoot, 'analyst', malformedSegment.entry.filename);
    const malformedEnvelope = JSON.parse(readFileSync(malformedPath, 'utf8').trim()) as { rows: Array<{ content?: string }> };
    malformedEnvelope.rows[1]!.content = JSON.stringify({ event: 'activation_open', agent_name: 'analyst' });
    writeFileSync(malformedPath, `${JSON.stringify(malformedEnvelope)}\n`);
    const malformedBefore = readFileSync(malformedPath);
    expect(() => stabilize(malformedRoot, SESSION)).toThrow();
    expect(readFileSync(malformedPath)).toEqual(malformedBefore);

    const preambleRoot = projectRoot();
    const systemText = { ...ingress[1], role: 'system' as const, id: `${SESSION}:invalid-preamble`, content: '[workspace-context] stale', round_id: ingress[0].round_id, message_index: 0, block_index: 1 };
    appendConversationBatch({ projectRoot: preambleRoot }, ingress);
    const preambleSegment = readCurrentConversationSegment(preambleRoot, SESSION)!;
    const preamblePath = globalAgentConversationVersionFile(preambleRoot, 'analyst', preambleSegment.entry.filename);
    const preambleEnvelope = JSON.parse(readFileSync(preamblePath, 'utf8').trim()) as { rows: unknown[] };
    preambleEnvelope.rows.splice(1, 0, systemText);
    writeFileSync(preamblePath, `${JSON.stringify(preambleEnvelope)}\n`);
    const preambleBefore = readFileSync(preamblePath);
    expect(() => stabilize(preambleRoot, SESSION)).toThrow();
    expect(readFileSync(preamblePath)).toEqual(preambleBefore);
  });

  it.each([SESSION, OVERSIGHT_SESSION])('settles exactly one final unmatched call in %s without new ingress or notice', (sessionId) => {
    const root = projectRoot();
    initializeMissingConversation(root, sessionId);
    const inputId = '11111111-1111-4111-8111-111111111111';
    const ingress = buildGlobalAgentIngressRows(sessionId, inputId, 'question');
    appendConversationBatch({ projectRoot: root }, ingress);
    appendConversationBatch({ projectRoot: root }, [{
      id: `${inputId}:tool-call:call-startup`, session_id: sessionId, role: 'assistant', kind: 'tool_call',
      tool: 'resume_runtime', tool_call_id: 'call-startup', context_policy: toolCallRowPolicy(),
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-startup', type: 'function', function: { name: 'resume_runtime', arguments: '{}' } }] }),
      round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 3, block_index: 0, timestamp: ingress[1].timestamp,
    }]);
    const segment = readCurrentConversationSegment(root, sessionId)!;
    const path = globalAgentConversationVersionFile(root, sessionId === SESSION ? 'analyst' : 'oversight', segment.entry.filename);
    const before = readFileSync(path);

    stabilize(root, sessionId);
    expect(readFileSync(path).subarray(0, before.length)).toEqual(before);
    const rows = readConversation(root, sessionId).physicalRows;
    expect(rows.slice(0, -1)).toEqual(segment.rows);
    const result = rows.at(-1)!;
    expect(result).toMatchObject({ kind: 'tool_result', tool: 'resume_runtime', tool_call_id: 'call-startup',
      context_policy: { kind: 'tool_result', settlement_origin: 'execution_failed', evidence: { kind: 'none' } } });
    const policy = segment.rows.at(-1)!.context_policy;
    if (policy.kind !== 'tool_call') throw new Error('Fixture requires a tool call policy.');
    expect(result.context_policy).toMatchObject({ call_policy_sha256: policy.template_sha256 });
    expect(JSON.parse(result.content)).toEqual({ success: false, error: 'Prior activation ended without a recorded tool result. External or domain effects may or may not have happened. The prior call will not be replayed.', data: { outcome_unknown: true } });
    const settled = readFileSync(path);
    stabilize(root, sessionId);
    expect(readFileSync(path)).toEqual(settled);
  });

  it('selected global owning consumption discards a proven unterminated suffix', () => {
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); const before = readFileSync(path); appendFileSync(path, '{"broken":');
    expect(() => stabilize(root, SESSION)).not.toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect(readConversation(root, SESSION).physicalRows).toEqual(segment.rows);
  });

  it.each(['schema', 'semantic'] as const)('does not discard a suffix after complete %s-invalid global history', (fault) => {
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    const envelope = JSON.parse(segment.bytes.toString().trim());
    appendFileSync(path, fault === 'schema' ? '{"complete":"invalid"}\n' : `${JSON.stringify({ ...envelope, rows: envelope.rows.slice(1) })}\n`);
    appendFileSync(path, '{"broken":'); const before = readFileSync(path);
    expect(() => stabilize(root, SESSION)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(['nonfinal-call', 'multiple-calls', 'genesis', 'wrong-session', 'unsupported-version', 'no-complete-prefix', 'invalid-earlier-envelope'] as const)('fails %s without changing consumed bytes', (fault) => {
    const root = projectRoot();
    const input = '11111111-1111-4111-8111-111111111111';
    const ingress = buildGlobalAgentIngressRows(SESSION, input, 'question');
    appendConversationBatch({ projectRoot: root }, ingress);
    appendStartupPendingCall(root, SESSION, input);
    const segment = readCurrentConversationSegment(root, SESSION)!;
    const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    const envelopes = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    if (fault === 'nonfinal-call') envelopes.push({ ...envelopes[1], rows: [{ ...ingress[1], id: 'later-text' }] });
    else if (fault === 'multiple-calls') envelopes.push({ ...envelopes[1], rows: [{ ...envelopes[1].rows[0], id: `${input}:tool-call:second`, tool_call_id: 'second', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'second', type: 'function', function: { name: 'read', arguments: '{}' } }] }) }] });
    else if (fault === 'genesis') envelopes[0].rows[0] = { invalid: 'genesis' };
    else if (fault === 'wrong-session') envelopes[0].rows[1].session_id = OVERSIGHT_SESSION;
    else if (fault === 'unsupported-version') envelopes[0].version = 999;
    else if (fault === 'invalid-earlier-envelope') envelopes[0] = { invalid: 'complete earlier envelope' };
    writeFileSync(path, fault === 'no-complete-prefix' ? '{"torn":' : `${envelopes.map((entry) => JSON.stringify(entry)).join('\n')}\n{"torn":`);
    const before = readFileSync(path);
    expect(() => stabilize(root, SESSION)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it('requires selected state: missing indexes and indexed segments are not exempted',()=>{
    const root=projectRoot();
    expect(()=>stabilize(root,OVERSIGHT_SESSION)).toThrow();
    rmSync(globalAgentConversationVersionIndexFile(root, 'analyst'));
    expect(()=>stabilize(root,SESSION)).toThrow();
    initializeMissingConversation(root, SESSION);
    appendConversationBatch({projectRoot:root},buildGlobalAgentIngressRows(SESSION,'22222222-2222-4222-8222-222222222222','check'));
    const segment=readCurrentConversationSegment(root,SESSION)!;
    rmSync(globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename));
    expect(()=>stabilize(root,SESSION)).toThrow();
  });
});

function projectRoot(): string { const root = mkdtempSync(join(tmpdir(), 'global-agent-startup-validation-')); roots.push(root); initProjectTree(root); return root; }
