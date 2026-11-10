import { describe, expect, it } from '@jest/globals';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import {
  compileProjectWorkflows,
  describeNodeResultContract,
} from '../../src/runtime/card-process/card-process-config.js';
import { agentExecution, directEdge } from '../helpers/workflow-execution.js';
import { writeRecordPatterns } from '../helpers/capability-grants.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const template = resolveSystemTemplate('newloop2');
const source = template.config.card_types!;
const compiled = compileProjectWorkflows(
  effectiveSaivageConfigSchema.parse(structuredClone(template.config)),
  { defaultPromptRoot: template.promptRoot },
);
describe('newloop2 standalone compiled declarations', () => {
  it('owns an independent deeply frozen graph without changing shared grants, routes or OFF policy', () => {
    const typed = resolveSystemTemplate('classic-typed').config;
    expect(template.config).not.toBe(typed);
    const { card_types: _new, ...globals } = template.config;
    const { card_types: _old, ...oldGlobals } = typed;
    expect(globals).toEqual(oldGlobals);
    expect(Object.isFrozen(source.project!.workflow.nodes)).toBe(true);
    expect(
      writeRecordPatterns(compiled.agents.get('planner')!).map((pattern) => pattern.source),
    ).toEqual(['status.md', 'brief.md']);
  });
  it.each(['project', 'goal'])(
    '%s fresh success cannot bypass aligned delivery, integrated acceptance and final debt',
    (type) => {
      const workflow = source[type]!.workflow;
      expect(workflow.entries).toEqual({
        BACKLOG: { node: 'frame-plan' },
        CHANGED: { node: 'resume-assess' },
        BLOCKED: { node: 'resume-assess' },
        STOPPED: {
          node: 'resume-assess',
          prompt: { reference: 'stopped-recovery', compactable: true },
        },
      });
      const successes: string[][] = [];
      // Enumerate simple paths in the actual declaration, not a test-owned execution engine.
      const visit = (node: string, path: string[]) => {
        if (path.includes(node)) return;
        const next = [...path, node];
        for (const declaration of Object.values(workflow.nodes[node]!.edges)) {
          const edge = directEdge(declaration);
          if ('node' in edge.target) visit(edge.target.node, next);
          else if (edge.target.terminal === 'DONE') successes.push(next);
        }
      };
      visit('frame-plan', []);
      expect(successes).toHaveLength(1);
      expect(successes[0]).toEqual(
        type === 'project'
          ? [
              'frame-plan',
              'alignment',
              'deliver',
              'objective-assessment',
              'integrated-acceptance',
              'debt-assessment',
            ]
          : ['frame-plan', 'alignment', 'deliver', 'integrated-acceptance', 'debt-assessment'],
      );
      for (const [id, node] of Object.entries(workflow.nodes)) {
        expect(directEdge(node.edges.blocked!).target).toMatchObject({
          terminal: 'BLOCKED',
          promote: 'current',
        });
        expect(directEdge(node.edges.failed!).target).toMatchObject({
          terminal: 'FAILED',
          promote: 'current',
        });
        for (const declaration of Object.values(node.edges)) {
          const edge = directEdge(declaration);
          if ('terminal' in edge.target && edge.target.terminal === 'DONE') {
            expect(id).toBe('debt-assessment');
            expect(edge.target).toEqual({
              terminal: 'DONE',
              promote: 'current',
              export_records: ['review.md'],
            });
            expect(edge.pending_notifications).toMatchObject({ node: 'resume-assess' });
          }
        }
      }
    },
  );
  it('compiles every named session, outcome, gate, feed and initializer across all nine types', () => {
    expect([...compiled.cardTypes.keys()].sort()).toEqual(
      ['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'].sort(),
    );
    for (const [type, process] of compiled.cardTypes) {
      expect(process.bootstrapRecord.name).toBe('brief.md');
      for (const state of process.states.values())
        if (state.kind === 'node') {
          const node = source[type]!.workflow.nodes[state.nodeId]!;
          const execution = agentExecution(state);
          const review = execution.agent.name === 'reviewer';
          expect(execution.agent.name).toBe(
            ['project', 'goal'].includes(type)
              ? review
                ? 'reviewer'
                : 'planner'
              : review
                ? 'reviewer'
                : 'executor',
          );
          expect(state.initializeRecords.map((record) => record.name)).toEqual([
            review ? 'review.md' : 'status.md',
          ]);
          expect(state.requirements).toEqual([
            expect.objectContaining({ mode: review ? 'clean' : 'continue', gate: 'updated' }),
          ]);
          const pairs = node.record_prompts!.map((feed) => [
            feed.record,
            feed.selection,
            feed.presence,
          ]);
          expect(pairs).toEqual([
            ['brief.md', 'accepted', 'required'],
            ['status.md', 'effective', 'optional'],
            ...(source[type]!.records['review.md'] ? [['review.md', 'accepted', 'optional']] : []),
            ...(review ? [['review.md', 'effective', 'optional']] : []),
          ]);
          if (review && ['project', 'goal'].includes(type))
            expect(node.descendant_context).toEqual({
              records: ['status.md'],
              require_unchanged_until_accept: true,
            });
          if (type === 'architecture') expect(node.descendant_context).toBeUndefined();
          expect(describeNodeResultContract(process, `node:${state.nodeId}`)).toBeTruthy();
          for (const declaration of Object.values(node.edges)) {
            const edge = directEdge(declaration);
            if ('node' in edge.target)
              expect(process.states.has(`node:${edge.target.node}`)).toBe(true);
            if (edge.pending_notifications)
              expect(process.states.has(`node:${edge.pending_notifications.node}`)).toBe(true);
          }
        }
      const evidence=globalThis.process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
      if(evidence){
        mkdirSync(evidence,{recursive:true});
        writeFileSync(join(evidence,`newloop2-compiled-${type}-selection.json`),JSON.stringify({
          declaration:source[type],
          states:[...process.states.values()].map(state=>({...state,...(state.kind==='node'?{on:[...state.on]}:{})})),
          processPrompts:[...process.processPrompts],
        },null,2));
      }
    }
  });
});
