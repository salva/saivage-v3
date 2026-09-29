import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateConfiguredGlobalConversation } from '../../src/application/global-agent-startup-validation.js';
import { appendConversationBatch, initializeMissingConversation, readConversation, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { globalAgentConversationVersionFile } from '../../src/persistence/layout.js';
import { buildAnalystIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { toolCallRowPolicy } from '../helpers/row-policy-fixtures.js';

const SESSION = 'agent:analyst:global' as const;
const OVERSIGHT_SESSION = 'agent:oversight:global' as const;
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('configured selected-global runtime validation', () => {
  it('accepts a configured empty catalog without publication', () => {
    const root = projectRoot();
    expect(readCurrentConversationSegment(root, SESSION)).toBeNull();
    validateConfiguredGlobalConversation(root, SESSION);
    expect(readCurrentConversationSegment(root, SESSION)).toBeNull();
  });

  it('byte-preserves valid current conversation data', () => {
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildAnalystIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); const before = readFileSync(path);
    validateConfiguredGlobalConversation(root, SESSION);
    expect(readFileSync(path)).toEqual(before);
  });

  it('admits retained ordinary system text beside later two-row ingress without rewriting it', () => {
    const root = projectRoot();
    const old = buildAnalystIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'old question');
    const retained = { ...old[1], id: `${SESSION}:retained-note`, role: 'system' as const, content: '[workspace-context] view: cockpit', round_id: old[0].round_id, message_index: 0, block_index: 1 };
    appendConversationBatch({ projectRoot: root }, [old[0], retained, old[1]]);
    appendConversationBatch({ projectRoot: root }, buildAnalystIngressRows(SESSION, '22222222-2222-4222-8222-222222222222', 'new question'));
    const segment = readCurrentConversationSegment(root, SESSION)!;
    const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    const before = readFileSync(path);
    expect(readConversation(root, SESSION).sourceRows.map((row) => row.content)).toContain(retained.content);
    validateConfiguredGlobalConversation(root, SESSION);
    expect(readFileSync(path)).toEqual(before);
  });

  it('rejects malformed marker content and marker-free system-text preambles without editing either', () => {
    const malformedRoot = projectRoot();
    const ingress = buildAnalystIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'question');
    appendConversationBatch({ projectRoot: malformedRoot }, ingress);
    const malformedSegment = readCurrentConversationSegment(malformedRoot, SESSION)!;
    const malformedPath = globalAgentConversationVersionFile(malformedRoot, 'analyst', malformedSegment.entry.filename);
    const malformedEnvelope = JSON.parse(readFileSync(malformedPath, 'utf8').trim()) as { rows: Array<{ content?: string }> };
    malformedEnvelope.rows[1]!.content = JSON.stringify({ event: 'activation_open', agent_name: 'analyst' });
    writeFileSync(malformedPath, `${JSON.stringify(malformedEnvelope)}\n`);
    const malformedBefore = readFileSync(malformedPath);
    expect(() => validateConfiguredGlobalConversation(malformedRoot, SESSION)).toThrow();
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
    expect(() => validateConfiguredGlobalConversation(preambleRoot, SESSION)).toThrow();
    expect(readFileSync(preamblePath)).toEqual(preambleBefore);
  });

  it('rejects a strict-valid sole final unmatched global call with bytes unchanged', () => {
    const root = projectRoot();
    const inputId = '11111111-1111-4111-8111-111111111111';
    const ingress = buildAnalystIngressRows(SESSION, inputId, 'question');
    appendConversationBatch({ projectRoot: root }, ingress);
    appendConversationBatch({ projectRoot: root }, [{
      id: `${inputId}:tool-call:call-startup`, session_id: SESSION, role: 'assistant', kind: 'tool_call',
      tool: 'resume_runtime', tool_call_id: 'call-startup', context_policy: toolCallRowPolicy(),
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-startup', type: 'function', function: { name: 'resume_runtime', arguments: '{}' } }] }),
      round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 3, block_index: 0, timestamp: ingress[1].timestamp,
    }]);
    const segment = readCurrentConversationSegment(root, SESSION)!;
    const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    const before = readFileSync(path);

    expect(() => validateConfiguredGlobalConversation(root, SESSION)).toThrow(/ends in an unmatched tool call/);
    expect(readFileSync(path)).toEqual(before);
  });

  it('does not repair a malformed runtime suffix', () => {
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildAnalystIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); appendFileSync(path, '{"broken":'); const before = readFileSync(path);
    expect(() => validateConfiguredGlobalConversation(root, SESSION)).toThrow(/incomplete final envelope/);
    expect(readFileSync(path)).toEqual(before);
  });

  it('accepts absent Oversight state without creating it and validates its exact published session',()=>{
    const root=projectRoot();validateConfiguredGlobalConversation(root,OVERSIGHT_SESSION);
    initializeMissingConversation(root,OVERSIGHT_SESSION);
    appendConversationBatch({projectRoot:root},buildAnalystIngressRows(OVERSIGHT_SESSION,'22222222-2222-4222-8222-222222222222','check'));
    expect(()=>validateConfiguredGlobalConversation(root,OVERSIGHT_SESSION)).not.toThrow();
  });
});

function projectRoot(): string { const root = mkdtempSync(join(tmpdir(), 'global-agent-startup-validation-')); roots.push(root); initProjectTree(root); return root; }
