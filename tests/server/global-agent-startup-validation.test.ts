import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateConfiguredGlobalConversation } from '../../src/application/global-agent-startup-validation.js';
import { appendConversationBatch, initializeMissingConversation, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
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
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildAnalystIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'workspace', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); const before = readFileSync(path);
    validateConfiguredGlobalConversation(root, SESSION);
    expect(readFileSync(path)).toEqual(before);
  });

  it('rejects a strict-valid sole final unmatched global call with bytes unchanged', () => {
    const root = projectRoot();
    const inputId = '11111111-1111-4111-8111-111111111111';
    const ingress = buildAnalystIngressRows(SESSION, inputId, 'workspace', 'question');
    appendConversationBatch({ projectRoot: root }, ingress);
    appendConversationBatch({ projectRoot: root }, [{
      id: `${inputId}:tool-call:call-startup`, session_id: SESSION, role: 'assistant', kind: 'tool_call',
      tool: 'resume_runtime', tool_call_id: 'call-startup', context_policy: toolCallRowPolicy(),
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-startup', type: 'function', function: { name: 'resume_runtime', arguments: '{}' } }] }),
      round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 3, block_index: 0, timestamp: ingress[2].timestamp,
    }]);
    const segment = readCurrentConversationSegment(root, SESSION)!;
    const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    const before = readFileSync(path);

    expect(() => validateConfiguredGlobalConversation(root, SESSION)).toThrow(/ends in an unmatched tool call/);
    expect(readFileSync(path)).toEqual(before);
  });

  it('does not repair a malformed runtime suffix', () => {
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildAnalystIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'workspace', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); appendFileSync(path, '{"broken":'); const before = readFileSync(path);
    expect(() => validateConfiguredGlobalConversation(root, SESSION)).toThrow(/incomplete final envelope/);
    expect(readFileSync(path)).toEqual(before);
  });

  it('accepts absent Oversight state without creating it and validates its exact published session',()=>{
    const root=projectRoot();validateConfiguredGlobalConversation(root,OVERSIGHT_SESSION);
    initializeMissingConversation(root,OVERSIGHT_SESSION);
    appendConversationBatch({projectRoot:root},buildAnalystIngressRows(OVERSIGHT_SESSION,'22222222-2222-4222-8222-222222222222','scheduled-oversight','check'));
    expect(()=>validateConfiguredGlobalConversation(root,OVERSIGHT_SESSION)).not.toThrow();
  });
});

function projectRoot(): string { const root = mkdtempSync(join(tmpdir(), 'global-agent-startup-validation-')); roots.push(root); initProjectTree(root); return root; }
