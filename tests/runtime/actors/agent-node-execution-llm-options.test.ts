import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { appendConversationBatch } from '../../../src/persistence/conversation-file.js';

type LlmInputBuilder = {
  buildLlmInput(node: unknown, input: unknown, sessionId: string, inputId: string, contract: unknown, surface: unknown): PreparedLlmInvocationInput;
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('AgentNodeExecution LLM options', () => {
  it('uses the compiled agent route maxTokens as the prepared completion request', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-agent-node-options-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.saivage', 'cards', 'project', 'conversations'), { recursive: true });
    const sessionId = 'agent:planner:project';
    appendConversationBatch({ projectRoot }, [{
      id: 'activation', session_id: sessionId, role: 'system', kind: 'activity',
      content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-07-23T00:00:00.000Z' }),
      round_id: 'r-pre-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-23T00:00:00.000Z',
    }]);

    const store = {
      workflows: { cardTypes: new Map([['project', { bootstrapRecord: { name: 'brief.md' } }]]) },
      readRecord: () => ({ artifact: { content: 'brief' } }),
      listChildren: () => [],
    };
    const runner = new AgentNodeExecution({
      projectRoot,
      cardId: 'project',
      store,
      conversations: { projectRoot },
      promptTemplates: { render: () => 'system' },
      compactionConfig: {
        input_budget_tokens: 1_000,
        trigger_fraction: 0.7,
        completion_reserve_fraction: 0.2,
        merge_line_fraction: 0.2,
        summary_line_fraction: 0.4,
        escalate_merge_line_fraction: 0.3,
        escalate_summary_line_fraction: 0.5,
        snap: 'keep_straddler_verbatim',
      },
      candidateChains: new Map([['planner', [{ provider: 'test', account: null, model: 'planner-model' }]]]),
    } as never, {} as never) as unknown as LlmInputBuilder;

    const prepared = runner.buildLlmInput(
      { agent: { name: 'planner', model: { temperature: 0.2, maxTokens: 73 } } },
      { card: { id: 'project', type: 'project', title: 'Project' }, caller: 'runtime' },
      sessionId,
      'input',
      { describe: () => 'contract', terminals: [] },
      { agentName: 'planner', tools: new Map(), providers: [] },
    );

    expect(prepared.preparedCompaction).toMatchObject({
      reservedCompletionTokens: 200,
      requestedCompletionTokens: 73,
    });
  });
});
