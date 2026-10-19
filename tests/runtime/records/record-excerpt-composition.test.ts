import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { deterministicSummarySerialization } from '../../helpers/summary-serialization.js';
import { noCompactionProgress } from '../../helpers/executing-llm-snapshot.js';
import { CardService } from '../../../src/cards/card-service.js';
import { resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { compileProjectWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { bootstrapContextSupplier } from '../../../src/runtime/records/bootstrap-context.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { appendActivationMarker, buildUserContextMessage, providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import { buildPreparedInvocationContext } from '../../../src/runtime/actors/context/context-blocks.js';
import { compact, prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';

const session = 'agent:planner:project' as const;
const candidate = { provider: 'test', account: null, model: 'test' } as const;

describe('bundled record excerpt composition', () => {
  it.each(['classic', 'classic-typed', 'paad-typed'] as const)('retains actual %s excerpt and draft facts through summary, zero-tail compaction and re-entry', async name => {
    const root = mkdtempSync(join(tmpdir(), 'record-excerpt-composition-'));
    try {
      initProjectTree(root);
      const template = resolveSystemTemplate(name);
      const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
      // Exercise the existing protected-prompt contract, not a new retention policy.
      config.card_types.project!.workflow.nodes.plan!.record_prompts!.forEach(input => {
        input.prompt.compactable = false;
      });
      const workflows = compileProjectWorkflows(config, { projectRoot: root, defaultPromptRoot: template.promptRoot });
      const node = workflows.cardTypes.get('project')!.states.get('node:plan')!;
      if (node.kind !== 'node') throw new Error('Missing plan node.');
      const store = new CardService(root, workflows);
      store.acceptRecord('project', 'brief.md', 'Accepted requirement stays authoritative.', { kind: 'agent', agent: 'analyst' });
      store.openRecord('project', 'status.md');
      const source = 'FIRST\n' + 'ordinary status work remains unfinished.\n'.repeat(1000) + 'LAST';
      store.editRecord('project', 'status.md', source);
      const supplier = bootstrapContextSupplier(store, store.read('project')!, node);
      appendActivationMarker({ projectRoot: root }, session, {
        event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: randomUUID(),
        instructions: { kind: 'unavailable', reason: 'not_recorded' },
      });
      const first = supplier({ inputId: randomUUID(), conversation: readConversation(root, session) });
      appendConversationBatch({ projectRoot: root }, [...first.rows, buildUserContextMessage(
        session, randomUUID(), 'continuation_hook', 0, { role: 'user', content: 'Prior ordinary work detail. '.repeat(1000) },
      )]);
      const excerpt = first.rows.find(row => row.kind === 'record_prompt' && row.record_observations![0]!.observed.record_name === 'status.md')!;
      expect(excerpt.record_observations![0]!.observed).toMatchObject({ selection: { kind: 'draft' }, exposure: { kind: 'excerpt' } });
      expect(excerpt.content).toContain('Oversized record preview:');
      const preparedCompaction = prepareCompaction({ context_utilization_fraction: 0.8, trigger_fraction: 0.8,
        tail_fraction: 0, snap: 'compact_straddler' }, 'system', [], 30000, 2000);
      const input: PreparedLlmInvocationInput = {
        inputId: randomUUID(), agentId: session, agentName: 'planner', sessionId: session, systemPrompt: 'system',
        providerConversation: providerConversationProjection(readConversation(root, session), first.recordBlocks),
        tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 },
        preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [],
          compiledTools: [], stableBlocks: [], recordBlocks: first.recordBlocks, preparedCompaction }),
        capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [candidate] },
      };
      const summaries: string[] = [];
      const result = await compact({ strategy: 'local_exact_admission', summaryRefusal: null,
        conversations: { projectRoot: root }, input, signal: new AbortController().signal, progress: noCompactionProgress,
        summarizerProvider: {
          candidate, contextWindowTokens: 100000, maxOutputTokens: 10000,
          materializeImage: async () => { throw new Error('Unexpected image.'); }, serializeSummaryRequest: deterministicSummarySerialization,
          completeTurn: async request => {
            summaries.push(request.providerConversation.messages.map(message => message.content).join('\n'));
            return { result: { kind: 'message' as const, content: 'Earlier work remains subject to accepted requirements.' }, provider_exchanges: [] };
          }, projectProviderExchanges: () => [],
        },
      });
      expect(result.kind).toBe('compacted');
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.join('\n')).toContain(excerpt.content);
      expect(summaries.join('\n')).toContain('"kind":"excerpt"');
      const current = readConversation(root, session);
      expect(current.sourceRows).toEqual([]);
      const reentry = supplier({ inputId: randomUUID(), conversation: current });
      expect(reentry.rows).toEqual([]);
      const projection = providerConversationProjection(current, reentry.recordBlocks);
      expect(projection.messages.some(message => message.content === excerpt.content)).toBe(true);
      expect(projection.messages.map(message => message.content).join('\n')).toContain('Accepted requirement stays authoritative.');
      expect(store.readRecordCurrent('project', 'status.md')).toMatchObject({ value: { projection: { draft: { content: source } } } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
