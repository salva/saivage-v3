import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  newloop2Fixture,
  author,
  verdict,
  decision,
  selectedNode,
  seedDeliveryWorkspace,
  type Step,
} from '../helpers/newloop2-fixture.js';
import { testNotificationAuthority } from '../helpers/capability-grants.js';
import {
  appendConversationBatch,
  readConversation,
  readCurrentConversationSegment,
  readHistoricalConversationSegment,
} from '../../src/persistence/conversation-file.js';
import { deferred } from '../../src/runtime/actors/deferred.js';
import { workflowResult } from '../helpers/workflow-result.js';
import {
  appendActivationMarker,
  buildUserContextMessage,
  providerConversationProjection,
} from '../../src/runtime/actors/conversation-session.js';
import { appendLlmTurnToolCallBatch } from '../../src/runtime/actors/llm-delivery-log.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { canonicalJson, sha256Hex } from '../../src/schemas/index.js';
import { compact, prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import {
  buildPreparedInvocationContext,
  composedPreparedBlocks,
} from '../../src/runtime/actors/context/context-blocks.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { bootstrapContextSupplier } from '../../src/runtime/records/bootstrap-context.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';

jest.setTimeout(30000);
const fixtures: ReturnType<typeof newloop2Fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
function fixture(steps: Step[] = [], brief?: string) {
  const f = newloop2Fixture(steps, brief);
  fixtures.push(f);
  return f;
}
let planPass = 0,
  deliveryPass = 0,
  objectivePass = 0;
const frame = () =>
  decision(
    'frame-plan',
    'ready',
    `Plan revision ${++planPass} incorporates preceding findings. Need: accurate widget procedure. Existing manual contradicts actual switch order. Plan: inspect device specification, publish concise ordered instructions, verify examples. Retain full procedure scope.`,
  );
const aligned = () =>
  decision(
    'alignment',
    'aligned',
    'Checked device specification and intended operator task. Plan covers switch order and stop condition without adding unauthorized operations.',
  );
const delivery = () =>
  decision(
    'deliver',
    'candidate_ready',
    `Delivery correction ${++deliveryPass}: preceding finding resolved in widget guide and example checks; actual child output agrees with specification. Complete finite candidate.`,
  );
const objective = () =>
  decision(
    'objective-assessment',
    'candidate_ready',
    `Objective examination ${++objectivePass} of corrected delivery: whole finite operating-guide objective fulfilled, including safety stop instruction. No continuing obligation; evidence guide-A.`,
  );
const accepted = () =>
  decision(
    'integrated-acceptance',
    'accepted',
    'Inspected combined guide-A and device source: correct order, stop condition, usable example. Functional intent and aligned approach satisfied.',
  );
const clear = () =>
  decision(
    'debt-assessment',
    'clear',
    'guide-A structure is concise and consistent; no necessary refactor. The latest aligned plan and functional acceptance apply to this corrected candidate; root objective reconciliation remains applicable. Earlier revision findings remain historical, not approvals.',
  );
const fresh = () => [
  ...frame(),
  ...aligned(),
  ...delivery(),
  ...objective(),
  ...accepted(),
  ...clear(),
];
const activate = (
  node = 'deliver',
  card = 'card-a',
  instructions = 'Deliver the same accepted finite assignment with the supplied evidence.',
): Step => ({ node, tool: 'activate_card', args: { card_id: card, instructions } });
const resumeDelivery = () =>
  decision(
    'resume-assess',
    'deliver',
    'Supplied missing input resolves delivery blocker; original aligned approach and accepted unaffected evidence remain applicable.',
  );
function results(f: ReturnType<typeof fixture>) {
  return f.requests.flatMap((input) =>
    input.providerConversation.messages
      .filter((row) => row.role === 'tool')
      .map((row) => JSON.parse(row.content)),
  );
}
async function parked(f: ReturnType<typeof fixture>, owner: Awaited<ReturnType<typeof f.launch>>) {
  await Promise.race([
    f.atEnd,
    owner.settlement.promise.then((outcome) => {
      throw new Error(`Unexpected terminal: ${JSON.stringify(outcome)}`);
    }),
  ]);
}

const call = (card: string, node: string, tool: string, args: Step['args']): Step => ({
  card, node, tool, args,
});
const dispatch = (card: string, node: string, child: string, instructions: string): Step =>
  call(card, node, 'activate_card', { card_id: child, instructions });
const readPath = (card: string, node: string, path: string): Step =>
  call(card, node, 'read', { path });
const run = (card: string, node: string, command: string, cwd = '.'): Step =>
  call(card, node, 'run_command', { command, cwd });
const readAccepted = (card: string, node: string, target: string, name: string, version: number): Step =>
  call(card, node, 'read_record_version', { card_id: target, record_name: name, version });

function lastReceipt(input: PreparedLlmInvocationInput) {
  const row = input.providerConversation.messages.filter((message) => message.role === 'tool').at(-1);
  if (!row) throw new Error('Expected actual tool receipt in the prepared invocation');
  return JSON.parse(row.content);
}

function observe(next: Step, expected: object): Step {
  return {
    ...next,
    before: (input) => expect(lastReceipt(input)).toMatchObject(expected),
  };
}

function statusFromCommand(card: string, node: string, expected: object): Step {
  return {
    ...author(node, '', card),
    args: (input) => {
      const receipt = lastReceipt(input);
      expect(receipt).toMatchObject({
        success: true, data: { status: 'exited', exit_code: 0, stdout_complete: true },
      });
      expect(JSON.parse(receipt.data.stdout)).toMatchObject(expected);
      return { path: `record:///status.md?card=${card}`, content: receipt.data.stdout };
    },
  };
}

function toolCalls(f: ReturnType<typeof fixture>, sessionId: Parameters<typeof readConversation>[1], tool: string) {
  return readConversation(f.root, sessionId).sourceRows
    .filter((row) => row.kind === 'tool_call' && row.tool === tool)
    .map((row) => JSON.parse(JSON.parse(row.content).tool_calls[0].function.arguments));
}

const framing = (card: string, scope: string): Step[] => [
  ...decision('frame-plan', 'ready', scope, card),
  ...decision('alignment', 'aligned', `Checked bounded assignment and evidence: ${scope}`, card),
];

const doneRecord = (f: ReturnType<typeof fixture>, card: string, name: string) => {
  const lifecycle = f.cards.read(card)!.lifecycle;
  if (lifecycle.status !== 'done') throw new Error(`Expected ${card} to be DONE`);
  const exported = lifecycle.result.records.find((record) => record.name === name);
  if (!exported) throw new Error(`Missing ${name} export from ${card}`);
  return exported;
};

describe('newloop2 real owner semantic flows', () => {
  it.each([false, true])(
    'qualifies reviewed incorporation and dependent admission (interrupt writer: %s)',
    async (interrupt) => {
      const f = fixture([], 'Deliver quota 3 and its dependent calculation from the designated development line.');
      const { directory, base } = seedDeliveryWorkspace(f.root, interrupt);
      const containing = f.child('goal', 'project', 'Deliver the integrated quota and its dependent check; no parent delta.').id;
      const goal = f.child('goal', containing, 'Raise quota to 3, preserve widget label, and incorporate the reviewed result on development.').id;
      const dependent = f.child('ops', containing, 'Derive next quota from the incorporated prerequisite, not parked input.', [goal]).id;
      const code = f.child('code', goal, 'Produce the quota candidate and affected test, without writing development.').id;
      const stale = f.child('ops', goal, 'Try only the assigned, expired writer turn; report refusal.').id;
      const writer = f.child('ops', goal, 'Submit the exact approved replacement only under the current turn.').id;
      const baseId = sha256Hex(JSON.stringify(base));
      const rejected = { ...base, quota: 3, label: 'wrong-label' };
      const replacement = { ...base, quota: 3 };
      const candidateId = sha256Hex(JSON.stringify(replacement));
      const rejectedId = sha256Hex(JSON.stringify(rejected));
      const target = join(directory, 'development.json');
      const submit = (turn: string) => `node project.cjs submit replacement ${baseId} ${candidateId} ${turn}`;
      const runDelivery = (card: string, node: string, command: string) => run(card, node, command, 'delivery');
      const sameBase = () => expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(base));
      const receipt = (content: string) => ({ success: true, data: { content: { content } } });
      const evidence = (candidate: typeof base, identity: string) =>
        JSON.stringify({ base: baseId, identity, candidate, affectedCheck: true });
      const examine = (card: string, node: string, name: string) =>
        readPath(card, node, `project:///delivery/${name}`);
      const deniedDependent = dispatch(containing, 'deliver', dependent, 'Check that dependent admission waits for prerequisite DONE.');
      const proof = { destination: 'development.json', base: baseId, identity: candidateId, value: replacement };
      f.script([
          ...framing('project', 'Deliver the consumer quota objective.'),
          dispatch('project', 'deliver', containing, 'Deliver the integrated quota objective; both child results must apply.'),
          ...framing(containing, 'Incorporate the prerequisite before deriving the dependent quota.'),
          deniedDependent,
          observe(dispatch(containing, 'deliver', goal, 'Deliver the reviewed quota adjustment to development.'), {
            success: false, error: expect.stringContaining('incomplete dependencies'),
          }),
          ...framing(goal, 'Prepare and review quota 3 without changing the label; incorporate only the exact replacement.'),
          dispatch(goal, 'deliver', code, `Prepare from approved development ${baseId}; do not submit.`),
          runDelivery(code, 'red', `node project.cjs check-base ${baseId}`),
          observe(author('red', 'Affected quota check fails on the approved base: quota 2.', code), {
            success: true, data: { status: 'failed', exit_code: 1, stdout: JSON.stringify({ base: baseId, passed: false }) },
          }),
          verdict('red', 'red_confirmed', code),
          runDelivery(code, 'green', `node project.cjs prepare initial ${baseId} wrong-label`),
          statusFromCommand(code, 'green', { affectedCheck: true, identity: rejectedId }),
          verdict('green', 'green', code),
          ...decision('refactor', 'done', 'Initial combined candidate and check: project:///delivery/initial.json.', code),
          ...decision('deliver', 'candidate_ready', 'Combined candidate/check: project:///delivery/initial.json.', goal),
          examine(goal, 'integrated-acceptance', 'initial.json'),
          observe(author('integrated-acceptance', 'Reject: affected quota check passes but the combined candidate changes the widget label.', goal), receipt(evidence(rejected, rejectedId))),
          { ...verdict('integrated-acceptance', 'repair', goal), before: sameBase },
          { ...call(goal, 'deliver', 'reopen_card', { card_id: code }), before: sameBase },
          dispatch(goal, 'deliver', code, 'Keep the original approved base and widget label; replace the rejected candidate and rerun the check.'),
          ...decision('resume-assess', 'green', 'Reproduce the candidate from unchanged approved base; quota assertion still applies.', code),
          runDelivery(code, 'green', `node project.cjs prepare replacement ${baseId} widget`),
          statusFromCommand(code, 'green', { affectedCheck: true, identity: candidateId, candidate: replacement }),
          verdict('green', 'green', code),
          ...decision('refactor', 'done', 'Corrected combined candidate/check: project:///delivery/replacement.json.', code),
          ...decision('deliver', 'candidate_ready', 'Replacement is ready for examination, not yet incorporated: project:///delivery/replacement.json.', goal),
          examine(goal, 'integrated-acceptance', 'replacement.json'),
          observe(author('integrated-acceptance', `Exact replacement ${candidateId} preserves the widget label and passes the affected quota check.`, goal), receipt(evidence(replacement, candidateId))),
          verdict('integrated-acceptance', 'accepted', goal),
          readAccepted(goal, 'debt-assessment', goal, 'review.md', 3),
          observe(author('debt-assessment', `Review v3 applies to ${candidateId}; no structural correction; incorporation into development remains.`, goal), {
            success: true, data: { version: 3, content: { content: expect.stringContaining(candidateId) } },
          }),
          verdict('debt-assessment', 'ready_to_incorporate', goal),
          {
            ...dispatch(goal, 'deliver', stale, `Exact approved ${candidateId}, development base ${baseId}; submit only if turn-old is current.`),
            before: (input) => {
              sameBase();
              const context = JSON.stringify(input.providerConversation);
              expect(context).toContain('Accepted outcome: ready_to_incorporate');
              expect(context).toContain(`record:///review.md?card=${goal}&v=4`);
            },
          },
          runDelivery(stale, 'execute', submit('turn-old')),
          observe(author('execute', 'The project operation denied the expired turn; no incorporation claimed.', stale), {
            success: true, data: { status: 'failed', exit_code: 1, stderr: 'writer turn is not current' },
          }),
          verdict('execute', 'failed', stale),
          call(goal, 'deliver', 'cancel_card', { card_id: stale, reason: 'Expired assignment closed without effect.' }),
          {
            ...dispatch(goal, 'deliver', writer, `Fresh designated writer turn-current. Use the project submit operation with project:///delivery/replacement.json (${candidateId}) and development base ${baseId}. Scope: exactly the functional and debt judgments at record:///review.md?card=${goal}&v=3 and record:///review.md?card=${goal}&v=4.`),
            before: sameBase,
          },
          runDelivery(writer, 'execute', submit('turn-current')),
          ...(!interrupt ? [statusFromCommand(writer, 'execute', proof), verdict('execute', 'done', writer)] : []),
      ]);
      const launch = await f.launch();

      if (interrupt) {
        const stopObserving = new AbortController();
        const observed = (async () => {
          for (let tries = 0; tries < 400; tries++) {
            if (existsSync(join(directory, 'writes'))) return;
            await delay(20, undefined, { signal: stopObserving.signal });
          }
          throw new Error('Writer never reached the held verification boundary');
        })();
        try {
          await Promise.race([
            observed,
            launch.settlement.promise.then((result) => {
              throw new Error(`Writer did not reach interruption: ${JSON.stringify(result)}`);
            }),
          ]);
        } finally {
          stopObserving.abort();
          await observed.catch(() => undefined);
        }
        const executing = readConversation(f.root, `agent:executor:${writer}`).sourceRows
          .filter((row) => row.kind === 'activity' && JSON.parse(row.content).event === 'activation_open')
          .at(-1);
        if (!executing) throw new Error('Missing writer activation');
        const { instructions } = JSON.parse(executing.content);
        expect(instructions).toMatchObject({ kind: 'prepared', node: { node_id: 'execute' }, activation_id: expect.any(String) });
        const ownerId = `${instructions.activation_id}:node:0`;
        expect(f.childProcesses(writer)).toEqual([
          expect.objectContaining({
            card_id: writer, owner_id: ownerId, agent_session_id: ownerId, owner_kind: 'agent',
            command: submit('turn-current'), cwd: directory, status: 'running',
          }),
        ]);
        expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(replacement));
      } else {
        await parked(f, launch);
        expect(doneRecord(f, writer, 'status.md')).toMatchObject({ version: 1 });
        expect(f.record('status.md', writer)!.accepted!.content).toBe(JSON.stringify(proof));
      }
      const landed = readFileSync(target, 'utf8');
      await expect(f.supervisor.stopProject()).resolves.toMatchObject({ status: 'stopped', contained: true });
      await expect(launch.settlement.promise).rejects.toThrow('stopped');
      expect(f.childProcesses(writer).some((process) => process.status === 'running')).toBe(false);

      const resumedDelivery = (card: string, explanation: string) => decision('resume-assess', 'deliver', explanation, card);
      const writerSummary = call(goal, 'deliver', 'get_card', { id: writer, section: 'summary' });
      const inspectWriter = call(goal, 'deliver', 'list_card_versions', { card_id: writer });
      const reader = call(goal, 'deliver', 'diff_card_versions', (input) => {
        const result = lastReceipt(input);
        expect(result).toMatchObject({ success: true, data: { card_id: writer } });
        const previousSummary = input.providerConversation.messages.filter((row) => {
          if (row.role !== 'tool') return false;
          const { data } = JSON.parse(row.content);
          return data?.card_id === writer && data?.section === 'summary';
        }).at(-1);
        if (!previousSummary) throw new Error('Missing current writer selection');
        const selected = JSON.parse(previousSummary.content).data.version_seq;
        const versions = result.data.versions.items.map((item: { version: number }) => item.version).sort((a: number, b: number) => a - b);
        expect(versions.at(-1)).toBe(selected);
        return { card_id: writer, from_version: versions.at(-2), to_version: selected };
      });
      const readWriterExport = call(goal, 'deliver', 'read_record_version', (input) => {
        const result = lastReceipt(input);
        expect(result).toMatchObject({ success: true, data: { card_id: writer } });
        const lifecycle = JSON.parse(result.data.diff.content).find(({ field }: { field: string }) => field === 'lifecycle');
        expect(lifecycle.after).toMatchObject({ status: 'done', result: { node_id: 'execute', outcome: 'done' } });
        const record = lifecycle.after.result.records[0];
        expect(record).toEqual(doneRecord(f, writer, 'status.md'));
        return { card_id: writer, record_name: record.name, version: record.version };
      });
      const completion: Step[] = interrupt
        ? [
            observe(author('deliver', 'Stopped writer has no terminal incorporation receipt. Containment does not settle effects; withhold replay and dependent release.', goal), {
              success: true, data: { card_id: writer, card: { status: 'stopped' } },
            }),
            verdict('deliver', 'blocked', goal),
            deniedDependent,
            observe(author('deliver', 'Do not release dependent without a cleared prerequisite.', containing), {
              success: false, error: expect.stringContaining('incomplete dependencies'),
            }),
            verdict('deliver', 'blocked', containing),
            ...decision('deliver', 'blocked', 'Await authoritative incorporation evidence; no replacement writer.'),
          ]
        : [
            observe(inspectWriter, { success: true, data: { card_id: writer, card: { status: 'done' } } }),
            reader,
            readWriterExport,
            observe(author('deliver', `Verified ${candidateId} at development using the current DONE evidence of ${writer}; request examination of the completed assignment.`, goal), receipt(JSON.stringify(proof))),
            verdict('deliver', 'candidate_ready', goal),
            examine(goal, 'integrated-acceptance', 'development.json'),
            observe(readAccepted(goal, 'integrated-acceptance', writer, 'status.md', 1), receipt(JSON.stringify(replacement))),
            observe(author('integrated-acceptance', `Current development content matches approved ${candidateId}; the writer export binds actual effect to reviewed input.`, goal), receipt(JSON.stringify(proof))),
            verdict('integrated-acceptance', 'accepted', goal),
            author('debt-assessment', `Final exact ${candidateId}: whole scoped assignment complete with no remaining structural or incorporation obligation.`, goal),
            {
              ...verdict('debt-assessment', 'clear', goal),
              before: async () => {
                await expect(f.supervisor.submitNotification(
                  testNotificationAuthority(),
                  goal,
                  {
                    id: randomUUID(),
                    content: 'Before clearance, explicitly reconcile the observed development identity with the completed writer evidence. No new write is requested.',
                    created_at: new Date().toISOString(),
                  },
                  'normal',
                )).resolves.toMatchObject({ queued: true });
              },
            },
            author('debt-assessment', `Updated assessment before clearing ${candidateId}: queued owner clarification does not authorize another write.`, goal),
            verdict('debt-assessment', 'clear', goal),
            {
              ...author('resume-assess', 'Notification requests evidence reconciliation only. Existing functional judgment applies; resume final assessment without running another writer.', goal),
              before: (input) => {
                expect(JSON.stringify(input.providerConversation)).toContain('explicitly reconcile the observed development identity');
                expect(f.cards.read(goal)!.lifecycle.status).toBe('running');
                expect(f.cards.read(dependent)!.lifecycle.status).toBe('backlog');
              },
            },
            verdict('resume-assess', 'assess_debt', goal),
            readAccepted(goal, 'debt-assessment', writer, 'status.md', 1),
            observe(author('debt-assessment', `Current writer evidence reconciles ${candidateId} with the already incorporated result. No further change is outstanding.`, goal), receipt(JSON.stringify(proof))),
            verdict('debt-assessment', 'clear', goal),
            {
              ...dispatch(containing, 'deliver', dependent, `Continue using incorporated development ${candidateId}, not parked input.`),
              before: (input) => expect(lastReceipt(input)).toMatchObject({
                success: true, data: { card_id: goal, outcome: 'done', result: { records: [doneRecord(f, goal, 'review.md')] } },
              }),
            },
            runDelivery(dependent, 'execute', `node project.cjs continue ${candidateId}`),
            statusFromCommand(dependent, 'execute', { base: candidateId, nextQuota: 4 }),
            verdict('execute', 'done', dependent),
            ...decision('deliver', 'candidate_ready', 'Prerequisite incorporated and dependent derived from actual destination; no containing delta.', containing),
            examine(containing, 'integrated-acceptance', 'dependent.json'),
            observe(author('integrated-acceptance', 'Integrated quota and dependent check satisfy containing brief without another submit.', containing), receipt(JSON.stringify({ base: candidateId, nextQuota: 4 }))),
            verdict('integrated-acceptance', 'accepted', containing),
            ...decision('debt-assessment', 'clear', 'Children delivered all changes; no remaining containing obligation.', containing),
            ...decision('deliver', 'blocked', 'Containing goal complete; stop at the observed consumer handoff.'),
          ];
      const boundary = f.requests.length;
      f.script([
        ...resumedDelivery('project', 'Resume containing goal at the interrupted handoff.'),
        dispatch('project', 'deliver', containing, 'Reassess outstanding delivery after Stop; do not replay effects.'),
        ...resumedDelivery(containing, 'Prerequisite was not yet cleared.'),
        dispatch(containing, 'deliver', goal, 'Establish applicable authoritative result before release.'),
        ...resumedDelivery(goal, 'Find current writer settlement; do not dispatch a new writer.'),
        writerSummary,
        ...completion,
      ]);
      const outcome = await (await f.launch()).settlement.promise;
      if (outcome.status !== 'blocked') throw new Error(`Expected root to park: ${outcome.summary}`);
      expect(f.requests.slice(boundary).some((input) => selectedNode(input).card === writer)).toBe(false);
      expect(toolCalls(f, `agent:planner:${goal}`, 'activate_card').filter(({ card_id }) => card_id === writer)).toHaveLength(1);
      expect(toolCalls(f, `agent:executor:${writer}`, 'run_command')).toEqual([{ command: submit('turn-current'), cwd: 'delivery' }]);
      expect(readFileSync(join(directory, 'submit-attempts'), 'utf8')).toBe('turn-old\nturn-current\n');
      expect(readFileSync(join(directory, 'writes'), 'utf8')).toBe(`${candidateId}\n`);
      expect(readFileSync(target, 'utf8')).toBe(landed);
      expect(sha256Hex(landed)).toBe(candidateId);
      if (interrupt) {
        const writerRows = readConversation(f.root, `agent:executor:${writer}`).sourceRows;
        const submission = writerRows.find((row) => row.kind === 'tool_call' && row.tool === 'run_command')!;
        const receipts = writerRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === submission.tool_call_id);
        expect(receipts.some((row) => {
          const result = JSON.parse(row.content);
          return result.success && result.data.status === 'exited' && result.data.exit_code === 0;
        })).toBe(false);
        expect(f.cards.read(writer)!.lifecycle.status).toBe('stopped');
        expect(f.record('status.md', writer)?.accepted).toBeFalsy();
        expect(f.cards.read(goal)!.lifecycle.status).toBe('blocked');
        expect(f.cards.read(dependent)!.lifecycle.status).toBe('backlog');
        expect(existsSync(join(directory, 'dependent.json'))).toBe(false);
        expect(f.requests.some((input) => selectedNode(input).card === dependent)).toBe(false);
      } else {
        expect(doneRecord(f, goal, 'review.md')).toMatchObject({ version: 7 });
        expect(doneRecord(f, containing, 'review.md')).toMatchObject({ version: 3 });
        expect(readFileSync(join(directory, 'dependent.json'), 'utf8')).toBe(JSON.stringify({ base: candidateId, nextQuota: 4 }));
      }
    },
    60000,
  );

  it('compacts an actual Planner session and prepares its next real resume-assess invocation', async () => {
    const f = fixture([...frame(), ...aligned(), ...decision('deliver', 'blocked', 'Verification evidence unavailable; alignment remains applicable.')]);
    await expect((await f.launch()).settlement.promise).resolves.toMatchObject({ status: 'blocked' });
    const prepared = f.requests.filter(input => input.agentName === 'planner').at(-1)!;
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
      appendActivationMarker({ projectRoot: f.root }, prepared.sessionId, {
        event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' },
        agent_name: 'planner', card_id: 'project', input_id: inputId,
      });
      appendConversationBatch({ projectRoot: f.root }, [
        buildUserContextMessage(prepared.sessionId, inputId, 'process_transition', 0, {
          role: 'user', content: 'Later ordinary factual narrative. '.repeat(700),
        }),
      ]);
    }
    const source = readCurrentConversationSegment(f.root, prepared.sessionId)!;
    const preparedCompaction = prepareCompaction(
      { ...testAutonomousCompaction.compactionConfig, tail_fraction: 0.05 },
      prepared.systemPrompt, prepared.tools, 24000, 200,
    );
    const preparedContext = buildPreparedInvocationContext({
      ...prepared.preparedContext, instructionText: prepared.systemPrompt,
      terminalToolNames: prepared.terminalToolNames,
      compiledTools: prepared.compiledToolContracts, preparedCompaction,
    });
    const input = { ...prepared, preparedCompaction, preparedContext,
      providerConversation: providerConversationProjection(source.conversation, composedPreparedBlocks(preparedContext)),
    };
    const summaryRequests: unknown[] = [];
    const compacted = await compact({
      strategy: 'preventive', summaryRefusal: null, conversations: { projectRoot: f.root }, input,
      summarizerProvider: {
        candidate: { provider: 'test', account: null, model: 'test-model' },
        contextWindowTokens: 100000, maxOutputTokens: 10000,
        materializeImage: async () => { throw new Error('No images'); },
        serializeSummaryRequest: deterministicSummarySerialization,
        completeTurn: async request => {
          summaryRequests.push(request);
          return { result: { kind: 'message', content: 'Historical narrative summarized; exact earlier acceptance must be read for applicability.' }, provider_exchanges: [] };
        },
        projectProviderExchanges: () => undefined,
      },
      signal: new AbortController().signal, progress: noCompactionProgress,
    });
    expect(compacted.kind).toBe('compacted');
    expect(readHistoricalConversationSegment(f.root, prepared.sessionId, source.entry.version).rows).toEqual(source.rows);
    const beforeReentry = f.requests.length;
    f.script([
      ...decision('resume-assess', 'deliver', 'Supplied missing input resolves delivery blocker; original aligned approach and accepted unaffected evidence remain applicable.'),
      ...decision('deliver', 'blocked', 'Verification evidence unavailable; alignment remains applicable.'),
    ]);
    await expect((await f.launch()).settlement.promise).resolves.toMatchObject({ status: 'blocked' });
    const actualAfterCompaction = f.requests.slice(beforeReentry);
    expect(selectedNode(actualAfterCompaction[0]!)).toEqual({ card: 'project', node: 'resume-assess' });
    expect(actualAfterCompaction[0]!.agentName).toBe('planner');
    expect(actualAfterCompaction[0]!.providerConversation.messages.some(message =>
      message.kind === 'synthetic_context' && message.origin === 'history_summary',
    )).toBe(true);
    expect(actualAfterCompaction[0]!.preparedContext.prefix.instructionText).toBe(actualAfterCompaction[0]!.systemPrompt);
    expect(actualAfterCompaction[0]!.providerConversation.messages.some(message =>
      message.kind === 'synthetic_context' && message.block_identity === 'current-bootstrap:project',
    )).toBe(true);
    const directory = processEnvironmentEvidence();
    if (directory) writeFileSync(join(directory, 'newloop2-planner-compaction.json'), JSON.stringify({
      kind: 'actual Planner compact() with scripted summary and subsequent actual Supervisor primary preparation',
      input, summaryRequests, actualAfterCompaction,
    }, null, 2));
  });

  it('completes a small non-code objective with distinct current author and Reviewer evidence and reused sessions', async () => {
    const f = fixture([], 'Determine whether the sampled widget procedures contradict the documented order. Deliver a bounded report, not software.');
    const research = f.child('research', 'project', 'Compare the two observations to the documented order, and record limits.').id;
    const observations = 'Documented: inspect then operate.\nSample A: inspect then operate.\nSample B: inspect then operate.';
    const report = 'Two inspected samples match the documented inspect-then-operate order. No contradiction observed in A or B; not a claim about unsampled procedures.';
    writeFileSync(join(f.root, 'observations.txt'), observations);
    const content = (text: string) => ({ success: true, data: { content: { content: text } } });
    f.script([
      ...framing('project', 'Compare sample observations to documentation; deliver a bounded disposition, no repository or file promotion.'),
      dispatch('project', 'deliver', research, 'Read observations.txt, compare both samples, and write the bounded report.'),
      readPath(research, 'explore', 'project:///observations.txt'),
      observe(author('explore', 'Opened documented order and both sample observations.', research), content(observations)),
      verdict('explore', 'evidence_ready', research),
      ...decision('assess', 'refuted', 'The proposed contradiction is absent from both observed samples.', research),
      call(research, 'report', 'write', { path: 'project:///widget-report.md', content: report }),
      ...decision('report', 'done', 'Report at project:///widget-report.md, limited to observations A and B.', research),
      ...decision('deliver', 'candidate_ready', 'Research report complete and inspectable at project:///widget-report.md.'),
      ...decision('objective-assessment', 'candidate_ready', 'Bounded disposition is the whole objective; no publication or separate incorporation.'),
      readPath('project', 'integrated-acceptance', 'project:///widget-report.md'),
      observe(readPath('project', 'integrated-acceptance', 'project:///observations.txt'), content(report)),
      observe(author('integrated-acceptance', 'Compared report against both observations: supports bounded no-contradiction disposition, not global equivalence.'), content(observations)),
      verdict('integrated-acceptance', 'accepted'),
      ...decision('debt-assessment', 'clear', 'Report clearly preserves method, provenance and sample limits; no remaining delivery obligations.'),
    ]);
    const owner = await f.launch();
    await expect(owner.settlement.promise).resolves.toMatchObject({
      status: 'done',
      result: {
        node_id: 'debt-assessment',
        outcome: 'clear',
        executor: { agent: 'reviewer' },
        records: [{ name: 'review.md' }],
      },
    });
    expect([
      ...new Set(
        f.requests
          .filter((input) =>
            ['frame-plan', 'deliver', 'objective-assessment'].includes(selectedNode(input).node),
          )
          .map((input) => input.sessionId),
      ),
    ]).toEqual(['agent:planner:project']);
    expect([
      ...new Set(
        f.requests
          .filter((input) =>
            ['alignment', 'integrated-acceptance', 'debt-assessment'].includes(
              selectedNode(input).node,
            ),
          )
          .map((input) => input.sessionId),
      ),
    ]).toEqual(['agent:reviewer:project']);
    expect(f.record('review.md')!.accepted).toMatchObject({
      source_version: 3,
      author: { kind: 'card-agent', agent: 'reviewer', card_id: 'project' },
    });
    expect(f.cards.readRecordHistory('project', 'review.md')).toMatchObject({
      kind: 'found',
      value: {
        catalog: {
          versions: expect.arrayContaining([
            expect.objectContaining({ version: 1 }),
            expect.objectContaining({ version: 2 }),
          ]),
        },
      },
    });
    expect(readFileSync(join(f.root, 'widget-report.md'), 'utf8')).toBe(report);
    expect(existsSync(join(f.root, '.git'))).toBe(false);
    expect(existsSync(join(f.root, 'delivery'))).toBe(false);
    expect(toolCalls(f, `agent:executor:${research}`, 'run_command')).toEqual([]);
  });

  it('passes the reviewed check design to ordinary ops and reviews the actual artifact observation', async () => {
    const f = fixture([], 'Perform the bounded offline widget fixture check and report the actual observed artifact, not a release pass.');
    const architecture = f.child('architecture', 'project', 'Design a bounded check of the named packaged widget fixture.').id;
    const ops = f.child('ops', 'project', 'Use the approved design to check the named fixture artifact; do not write or submit it.', [architecture]).id;
    const design = 'Read the exact packaged-widget.json, not source-widget.json. Match the complete marker and report the observed fixture, marker, and offline scope.';
    const probe = { artifact: 'packaged-widget.json', marker: 'packaged-only', scope: 'offline-fixture' };
    const observed = `${JSON.stringify(probe)}\n`;
    writeFileSync(join(f.root, 'packaged-widget.json'), observed);
    writeFileSync(join(f.root, 'source-widget.json'), '{"marker":"source-only"}\n');
    const command = `grep -Fx '${JSON.stringify(probe)}' packaged-widget.json`;
    const content = (text: string) => ({ success: true, data: { content: { content: text } } });
    const designReview = 'System review: project:///check-design.md applies to the offline artifact only. Component review v1 covers exact marker and path selection. This does not qualify an artifact.';
    f.script([
      ...framing('project', 'Obtain a reviewed artifact-specific check design, execute it exactly once, then assess the actual result.'),
      dispatch('project', 'deliver', architecture, 'Design a bounded check distinguishing packaged-widget.json from source-widget.json.'),
      call(architecture, 'draft', 'write', { path: 'project:///check-design.md', content: design }),
      ...decision('draft', 'ready_for_component_review', 'Exact bounded check design: project:///check-design.md.', architecture),
      readPath(architecture, 'component-review', 'project:///check-design.md'),
      observe(author('component-review', 'Exact filename and complete marker distinguish fixture from source.', architecture), content(design)),
      verdict('component-review', 'approved', architecture),
      readPath(architecture, 'system-review', 'project:///check-design.md'),
      observe(readAccepted(architecture, 'system-review', architecture, 'review.md', 1), content(design)),
      observe(author('system-review', designReview, architecture), content('Exact filename and complete marker distinguish fixture from source.')),
      verdict('system-review', 'approved', architecture),
      call('project', 'deliver', 'read_record_version', (input) => {
        const receipt = lastReceipt(input);
        expect(receipt).toMatchObject({ success: true, data: { card_id: architecture, outcome: 'done' } });
        const record = receipt.data.result.records[0];
        return { card_id: architecture, record_name: record.name, version: record.version };
      }),
      call('project', 'deliver', 'activate_card', (input) => {
        const receipt = lastReceipt(input);
        expect(receipt).toMatchObject(content(designReview));
        return { card_id: ops, instructions: `Execute the check from ${receipt.data.version_url}: ${receipt.data.content.content}` };
      }),
      {
        ...readPath(ops, 'execute', 'project:///check-design.md'),
        before: (input) => {
          expect(JSON.stringify(input.providerConversation)).toContain(doneRecord(f, architecture, 'review.md').url);
        },
      },
      observe(run(ops, 'execute', command), content(design)),
      statusFromCommand(ops, 'execute', probe),
      verdict('execute', 'done', ops),
      call('project', 'deliver', 'read_record_version', (input) => {
        const receipt = lastReceipt(input);
        expect(receipt).toMatchObject({ success: true, data: { card_id: ops, outcome: 'done' } });
        const record = receipt.data.result.records[0];
        return { card_id: ops, record_name: record.name, version: record.version };
      }),
      observe(author('deliver', 'Artifact qualification evidence comes from the executed check, not the architecture verdict.'), content(observed)),
      verdict('deliver', 'candidate_ready'),
      ...decision('objective-assessment', 'candidate_ready', 'The finite offline check is the whole assigned result.'),
      readAccepted('project', 'integrated-acceptance', ops, 'status.md', 1),
      observe(author('integrated-acceptance', `The observed artifact and marker satisfy the offline consumer check; not release acceptance. Evidence: record:///status.md?card=${ops}&v=1.`), content(observed)),
      verdict('integrated-acceptance', 'accepted'),
      ...decision('debt-assessment', 'clear', 'Check result identifies exact artifact and bounded scope; no incorporation or follow-up action.'),
    ]);
    await expect((await f.launch()).settlement.promise).resolves.toMatchObject({ status: 'done' });
    expect(toolCalls(f, `agent:executor:${ops}`, 'run_command')).toEqual([{ command, cwd: '.' }]);
    expect(toolCalls(f, 'agent:planner:project', 'activate_card').map(({ card_id }) => card_id)).toEqual([architecture, ops]);
    expect(readFileSync(join(f.root, 'packaged-widget.json'), 'utf8')).toBe(observed);
    expect(existsSync(join(f.root, 'delivery'))).toBe(false);
  });

  it('runs alignment revision, preparatory child, detailed replan, delivery, root replan, acceptance repair and structural refactoring loops', async () => {
    const steps: Step[] = [
      ...frame(),
      ...decision(
        'alignment',
        'revise',
        'Source contradicts assumed switch order: revise plan before delivery.',
      ),
      ...frame(),
      ...aligned(),
      {
        node: 'deliver',
        tool: 'create_card',
        args: {
          type: 'doc',
          title: 'Inspect widget operating procedure',
          bootstrap_content:
            'Publish bounded source-grounded widget procedure evidence. This exploratory note is not the parent implementation.',
          depends_on: [],
        },
      },
      activate(),
      ...decision(
        'execute',
        'done',
        'Research note: device specification confirms A before B; exploratory note only, not implementation.',
        'card-a',
      ),
      ...decision(
        'deliver',
        'replan',
        'Exploration resolved design uncertainty. Newly detailed publication plan needs alignment.',
      ),
      ...frame(),
      ...aligned(),
      ...delivery(),
      ...decision(
        'objective-assessment',
        'replan',
        'Operating guide still omits stop-condition audience context. Full objective not yet candidate.',
      ),
      ...frame(),
      ...aligned(),
      ...delivery(),
      ...objective(),
      ...decision(
        'integrated-acceptance',
        'repair',
        'Same-approach correction: stop example text differs from approved procedure.',
      ),
      ...delivery(),
      ...objective(),
      ...accepted(),
      ...decision(
        'debt-assessment',
        'refactor',
        'Introduced duplicate stop instructions can drift. Consolidate one canonical procedure and validate examples.',
      ),
      ...frame(),
      ...aligned(),
      ...delivery(),
      ...objective(),
      ...accepted(),
      ...clear(),
    ];
    const f = fixture(steps);
    const owner = await f.launch();
    await expect(owner.settlement.promise).resolves.toMatchObject({
      status: 'done',
      result: { node_id: 'debt-assessment', outcome: 'clear' },
    });
    expect(f.cards.read('card-a')!.lifecycle.status).toBe('done');
    expect(f.requests.filter((input) => selectedNode(input).node === 'frame-plan')).toHaveLength(
      10,
    );
    expect(f.record('review.md')!.accepted!.content).toContain('no necessary refactor');
  });

  it('refuses scaffold/unchanged records and direct outcomes, then accepts a supported handoff', async () => {
    const f = fixture([
      verdict('frame-plan', 'ready'),
      verdict('frame-plan', 'complete_direct'),
      ...frame(),
      ...aligned(),
    ]);
    const owner = await f.launch();
    await parked(f, owner);
    expect(results(f)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ success: false, error: 'Record validation failed.' }),
        expect.objectContaining({ success: false }),
      ]),
    );
    expect(selectedNode(f.requests.at(-1)!)).toEqual({ card: 'project', node: 'deliver' });
    expect(f.cards.read('project')!.lifecycle.status).toBe('running');
  });

  it.each(['status.md', 'brief.md'])(
    'rejects changed selected descendant %s during review without accepting a success result',
    async (record) => {
      const steps = [
        ...frame(),
        ...aligned(),
        ...delivery(),
        ...objective(),
        author('integrated-acceptance', 'Candidate accepted before external child change.'),
        verdict('integrated-acceptance', 'accepted'),
        ...decision(
          'integrated-acceptance',
          'blocked',
          'Selected child inputs changed; redo affected examination.',
        ),
      ];
      const f = fixture(steps);
      f.child('doc');
      steps[steps.length - 3]!.before = () => {
        f.cards.acceptRecord('card-a', record, 'Changed selected descendant evidence.', {
          kind: 'agent',
          agent: record === 'brief.md' ? 'planner' : 'executor',
        });
      };
      const owner = await f.launch();
      await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'blocked' });
      expect(
        results(f).some(
          (result) => result.success === false && JSON.stringify(result).includes('changed'),
        ),
      ).toBe(true);
      expect(f.record('review.md')!.accepted!.content).toBe(
        'Selected child inputs changed; redo affected examination.',
      );
      expect(f.requests.some((input) => selectedNode(input).node === 'debt-assessment')).toBe(
        false,
      );
    },
  );

  it('characterizes own-status feeding without asserting a nonexistent own-record tuple fence', async () => {
    const steps = [
      ...frame(),
      author('alignment', 'Current examination includes external own status input.'),
      verdict('alignment', 'aligned'),
    ];
    const f = fixture(steps);
    steps[3]!.before = () => {
      f.cards.acceptRecord(
        'project',
        'status.md',
        'External current own status; examiner evaluates applicability.',
        { kind: 'external-agent', principal: 'fixture' },
      );
    };
    const owner = await f.launch();
    await parked(f, owner);
    expect(selectedNode(f.requests.at(-1)!).node).toBe('deliver');
    expect(f.record('review.md')!.accepted!.content).toContain('Current examination');
    expect(results(f).filter((result) => result.success === false)).toEqual([]);
  });

  it('retains incomplete-descendant terminal rejection at the current final debt boundary', async () => {
    const f = fixture([
      ...fresh(),
      ...decision(
        'debt-assessment',
        'reassess',
        'Unfinished selected child still required; continue diagnosis.',
      ),
    ]);
    f.child('doc');
    const owner = await f.launch();
    await parked(f, owner);
    expect(selectedNode(f.requests.at(-1)!).node).toBe('resume-assess');
    expect(
      results(f).some(
        (result) => result.success === false && JSON.stringify(result).includes('descendant'),
      ),
    ).toBe(true);
    expect(f.cards.read('project')!.lifecycle.status).toBe('running');
  });

  it.each([
    ['deliver', 'deliver', 'Missing test input supplied; aligned approach unchanged.'],
    [
      'integrated-acceptance',
      'accept',
      'Independent verification artifact supplied; candidate unchanged.',
    ],
    [
      'debt-assessment',
      'assess_debt',
      'Debt question resolved; prior functional acceptance still applies.',
    ],
  ] as const)(
    'selectively resumes BLOCKED %s without revisiting unaffected nodes',
    async (node, route, reason) => {
      const prefix =
        node === 'deliver'
          ? [...frame(), ...aligned()]
          : node === 'integrated-acceptance'
            ? [...frame(), ...aligned(), ...delivery(), ...objective()]
            : [...frame(), ...aligned(), ...delivery(), ...objective(), ...accepted()];
      const f = fixture([
        ...prefix,
        ...decision(
          node,
          'blocked',
          `Unavailable input at ${node}; preserve applicable earlier reviews.`,
        ),
      ]);
      await (
        await f.launch()
      ).settlement.promise;
      const prior = f.record('review.md')!.accepted!;
      const boundary = f.requests.length;
      const remainder =
        node === 'deliver'
          ? [...delivery(), ...objective(), ...accepted(), ...clear()]
          : node === 'integrated-acceptance'
            ? [...accepted(), ...clear()]
            : clear();
      f.script([...decision('resume-assess', route, reason), ...remainder]);
      const owner = await f.launch();
      await expect(owner.settlement.promise).resolves.toMatchObject({
        status: 'done',
        result: { node_id: 'debt-assessment', outcome: 'clear' },
      });
      expect(f.requests.slice(boundary).map((input) => selectedNode(input).node)).toEqual([
        'resume-assess',
        'resume-assess',
        ...remainder.map((step) => step.node),
      ]);
      const old = f.cards.readRecordVersion('project', 'review.md', prior.source_version);
      expect(old).toMatchObject({
        kind: 'found',
        value: {
          projection: { artifact: { accepted: { content: prior.content, author: prior.author } } },
        },
      });
    },
  );

  it('routes materially changed brief upstream while retaining immutable prior evidence', async () => {
    const f = fixture([
      ...frame(),
      ...aligned(),
      ...decision('deliver', 'blocked', 'Need owner input about stop condition.'),
    ]);
    await (
      await f.launch()
    ).settlement.promise;
    const prior = f.record('review.md')!.accepted!;
    f.cards.acceptRecord(
      'project',
      'brief.md',
      'Changed objective: guide must cover emergency cutoff also.',
      { kind: 'agent', agent: 'analyst' },
    );
    const boundary = f.requests.length;
    f.script([
      ...decision(
        'resume-assess',
        'frame',
        'New emergency-cutoff criterion materially changes analysis and validation; prior switch-order evidence remains factual.',
      ),
      ...frame(),
    ]);
    const owner = await f.launch();
    await parked(f, owner);
    expect(f.requests.slice(boundary).map((input) => selectedNode(input).node)).toEqual([
      'resume-assess',
      'resume-assess',
      'frame-plan',
      'frame-plan',
      'alignment',
    ]);
    expect(JSON.stringify(f.requests[boundary]!.providerConversation)).toContain(
      'emergency cutoff',
    );
    expect(f.cards.readRecordVersion('project', 'review.md', prior.source_version)).toMatchObject({
      kind: 'found',
      value: {
        projection: { artifact: { accepted: { content: prior.content, author: prior.author } } },
      },
    });
  });

  it('delivers final pending owner context to Planner assessment rather than dropping it at DONE', async () => {
    const steps = [
      ...fresh(),
      author(
        'debt-assessment',
        'Fresh verdict after notification-bearing snapshot; previous acceptance remains historical.',
      ),
      verdict('debt-assessment', 'clear'),
      ...decision(
        'resume-assess',
        'accept',
        'New owner evidence affects functional acceptance, not earlier plan.',
      ),
      ...accepted(),
      ...clear(),
    ];
    const f = fixture(steps);
    steps[11]!.before = async () => {
      await f.supervisor.submitNotification(
        testNotificationAuthority(),
        'project',
        {
          id: '11111111-1111-4111-8111-111111111111',
          content: 'Owner evidence: recheck stop example against source revision B.',
          created_at: new Date().toISOString(),
        },
        'normal',
      );
    };
    const owner = await f.launch();
    await expect(owner.settlement.promise).resolves.toMatchObject({
      status: 'done',
      result: { node_id: 'debt-assessment' },
    });
    const recipient = f.requests.find((input) => selectedNode(input).node === 'resume-assess')!;
    expect(recipient.sessionId).toBe('agent:planner:project');
    expect(JSON.stringify(recipient.providerConversation)).toContain('Owner evidence: recheck');
    expect(f.cards.read('project')!.pending_notifications).toEqual([]);
  });

  it.each([
    [
      'code',
      [
        ['red', 'red_confirmed'],
        ['green', 'green'],
        ['refactor', 'done'],
      ],
      'refactor',
      'refactor',
    ],
    [
      'test',
      [
        ['diagnose', 'coverage_ready'],
        ['verify', 'done'],
      ],
      'diagnose',
      'verify',
    ],
    [
      'research',
      [
        ['explore', 'evidence_ready'],
        ['assess', 'supported'],
        ['report', 'done'],
      ],
      'report',
      'report',
    ],
    [
      'data',
      [
        ['schema', 'schema_ready'],
        ['validate', 'valid'],
        ['implement', 'done'],
      ],
      'implement',
      'implement',
    ],
    [
      'architecture',
      [
        ['draft', 'ready_for_component_review'],
        ['component-review', 'approved'],
        ['system-review', 'approved'],
      ],
      'system_review',
      'system-review',
    ],
    ['doc', [['execute', 'done']], 'execute', 'execute'],
    ['ops', [['execute', 'done']], 'execute', 'execute'],
  ] as const)(
    'executes %s fresh production and selective review/verification reentry with current promotion',
    async (type, path, route, target) => {
      const leaf = path.flatMap(([node, outcome]) =>
        decision(
          node,
          outcome,
          `${type}/${node}: actual bounded fixture output and assigned validation; no claim of parent acceptance.`,
          'card-a',
        ),
      );
      const f = fixture([
        ...frame(),
        ...aligned(),
        activate(),
        ...leaf,
        ...decision(
          'deliver',
          'blocked',
          'Leaf accepted; parent integration awaiting source input.',
        ),
      ]);
      f.child(type);
      await expect((await f.launch()).settlement.promise).resolves.toMatchObject({
        status: 'blocked',
      });
      expect(f.cards.read('card-a')!.lifecycle.status).toBe('done');
      const initialReviewVersion =
        type === 'architecture' ? f.record('review.md', 'card-a')!.accepted!.source_version : null;
      const reentry: Step[] = [
        { node: 'deliver', tool: 'reopen_card', args: { card_id: 'card-a' } },
        activate(
          'deliver',
          'card-a',
          'New source input; reexamine only the affected final obligation, retaining applicable earlier work.',
        ),
      ];
      if (!['test', 'doc', 'ops'].includes(type))
        reentry.push(
          ...decision(
            'resume-assess',
            route,
            'Earlier work remains applicable; supplied evidence needs final scoped examination.',
            'card-a',
          ),
        );
      if (type === 'test')
        reentry.push(
          ...decision(
            'diagnose',
            'coverage_ready',
            'Coverage adequate; new evidence requires verify, not added tests.',
            'card-a',
          ),
        );
      reentry.push(...decision(target, 'done', `${type}: refreshed current verdict.`, 'card-a'));
      if (type === 'architecture')
        reentry[reentry.length - 1] = verdict(target, 'approved', 'card-a');
      reentry.push(
        ...decision(
          'deliver',
          'blocked',
          'Reentered child returned fresh verdict; retain parent unfinished scope.',
        ),
      );
      const boundary = f.requests.length;
      f.script([...resumeDelivery(), ...reentry]);
      await expect((await f.launch()).settlement.promise).resolves.toMatchObject({
        status: 'blocked',
      });
      const childNodes = f.requests
        .slice(boundary)
        .filter((input) => selectedNode(input).card === 'card-a')
        .map((input) => selectedNode(input).node);
      expect(childNodes).toEqual(
        type === 'test'
          ? ['diagnose', 'diagnose', 'verify', 'verify']
          : ['doc', 'ops'].includes(type)
            ? ['execute', 'execute']
            : ['resume-assess', 'resume-assess', target, target],
      );
      expect(f.cards.read('card-a')!.lifecycle).toMatchObject({ status: 'done' });
      if (type === 'architecture') {
        const review = f.record('review.md', 'card-a')!;
        expect(review.accepted!.content).toBe('architecture: refreshed current verdict.');
        expect(review.accepted!.source_version).not.toBe(initialReviewVersion);
        const expectedRecords = [
          {
            name: 'review.md',
            url: `${review.currentUrl}&v=${review.accepted!.source_version}`,
            version: review.accepted!.source_version,
          },
        ];
        const lifecycle = f.cards.read('card-a')!.lifecycle;
        if (lifecycle.status !== 'done') throw new Error('Expected completed architecture child');
        expect(lifecycle.result.records).toEqual(expectedRecords);

        const rows = readConversation(f.root, 'agent:planner:project').sourceRows;
        const activations = rows.filter(
          (row) =>
            row.kind === 'tool_call' &&
            row.tool === 'activate_card' &&
            JSON.parse(JSON.parse(row.content).tool_calls[0].function.arguments).card_id === 'card-a',
        );
        expect(activations).toHaveLength(2);
        const settlements = rows.filter(
          (row) => row.kind === 'tool_result' && row.tool_call_id === activations[1]!.tool_call_id,
        );
        expect(settlements).toHaveLength(1);
        const settlement = JSON.parse(settlements[0]!.content);
        expect(settlement).toMatchObject({ success: true, data: { outcome: 'done' } });
        expect(settlement.data.result.records).toEqual(expectedRecords);
      }
    },
  );

  it('keeps FAILED activation refusal separate from supported parent reopen and selective diagnosis', async () => {
    const f = fixture([
      ...frame(),
      ...aligned(),
      activate(),
      ...decision(
        'resume-assess',
        'red',
        'Changed diagnosis now supports new red regression.',
        'card-a',
      ),
      ...decision('red', 'blocked', 'Input still missing.', 'card-a'),
      ...decision('deliver', 'blocked', 'Child waiting for exact input.'),
    ]);
    f.child('code');
    f.cards.setStatus('card-a', 'running');
    f.cards.commitActivationOutcome(
      'card-a',
      {
        status: 'failed',
        summary: 'Prior conclusive diagnosis.',
        result: workflowResult('FAILED', 'Prior conclusive diagnosis.'),
      },
      new Date().toISOString(),
    );
    // First activation is refused; same parent performs a supported reopen, not lifecycle fabrication.
    f.script([
      ...frame(),
      ...aligned(),
      activate(),
      { node: 'deliver', tool: 'reopen_card', args: { card_id: 'card-a' } },
      activate(),
      ...decision('resume-assess', 'red', 'New diagnosis routes affected regression.', 'card-a'),
      ...decision('red', 'blocked', 'Exact required input unavailable.', 'card-a'),
      ...decision('deliver', 'blocked', 'Resolve the exact child input.'),
    ]);
    await expect((await f.launch()).settlement.promise).resolves.toMatchObject({
      status: 'blocked',
    });
    expect(results(f).some((result) => result.success === false)).toBe(true);
    expect(
      f.requests
        .filter((input) => selectedNode(input).card === 'card-a')
        .map((input) => selectedNode(input).node),
    ).toEqual(['resume-assess', 'resume-assess', 'red', 'red']);
  });

  it('uses actual parent write/edit grants, refuses self/grandchild/open drafts and supplies the same child fresh bootstrap without implicit activation', async () => {
    const steps: Step[] = [
      {
        ...author(
          'frame-plan',
          'Parent accepted revised finite requirements.',
          'card-a',
          'brief.md',
        ),
        before: () => {
          expect(f.cards.read('card-a')!.lifecycle.status).toBe('blocked');
        },
      },
      {
        node: 'frame-plan',
        tool: 'edit',
        args: {
          path: 'record:///brief.md?card=card-a',
          old_string: 'revised',
          new_string: 'final',
        },
      },
      {
        ...author('frame-plan', 'Not permitted self assignment.', 'project', 'brief.md'),
        before: () => {
          expect(f.cards.read('card-a')!.lifecycle.status).toBe('changed');
          expect(f.requests.filter((input) => selectedNode(input).card === 'card-a')).toEqual([]);
          expect(f.record('brief.md', 'card-a')!.accepted).toMatchObject({
            content: 'Parent accepted final finite requirements.',
            author: { kind: 'card-agent', agent: 'planner', card_id: 'project' },
          });
        },
      },
      author('frame-plan', 'Not permitted grandchild assignment.', 'card-a-a', 'brief.md'),
      author('frame-plan', 'Must not replace another open draft.', 'card-b', 'brief.md'),
      ...frame(),
      ...aligned(),
      activate(
        'deliver',
        'card-a',
        'This direction does not amend the accepted final finite requirements.',
      ),
      ...decision(
        'resume-assess',
        'frame',
        'Accepted parent amendment changes analysis; prior evidence remains historical.',
        'card-a',
      ),
      ...decision(
        'frame-plan',
        'blocked',
        'Need the exact unavailable domain decision under the newly supplied brief.',
        'card-a',
      ),
      ...decision('deliver', 'blocked', 'Same child proposal remains parent-owned.'),
    ];
    for (const step of steps.slice(0, 5)) step.card = 'project';
    const f = fixture(steps);
    f.child('goal');
    f.child('doc', 'card-a');
    f.child('doc');
    f.cards.setStatus('card-a', 'running');
    f.cards.commitActivationOutcome(
      'card-a',
      {
        status: 'blocked',
        summary: 'Need requirement decision.',
        result: workflowResult('BLOCKED', 'Need requirement decision.'),
      },
      new Date().toISOString(),
    );
    f.cards.openRecord('card-b', 'brief.md');
    f.cards.editRecord('card-b', 'brief.md', 'Existing interrupted draft.');
    const owner = await f.launch();
    await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'blocked' });
    const failures = results(f).filter((result) => result.success === false);
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'writer_not_authorized' }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({ code: 'record_open_conflict' }),
        }),
      ]),
    );
    const childInput = f.requests.find((input) => selectedNode(input).card === 'card-a')!;
    expect(
      childInput.providerConversation.messages.find(
        (message) =>
          'block_identity' in message && message.block_identity === 'current-bootstrap:card-a',
      )!.content,
    ).toContain('Parent accepted final finite requirements.');
    expect(f.record('brief.md', 'card-b')!.draft!.content).toBe('Existing interrupted draft.');
    const acceptedRows = readConversation(f.root, 'agent:planner:project').sourceRows.filter(
      (row) =>
        row.kind === 'tool_result' && ['newloop2-1', 'newloop2-2'].includes(row.tool_call_id!),
    );
    for (const row of acceptedRows)
      expect(JSON.parse(row.content)).toMatchObject({
        success: true,
        data: { surface: 'card_acceptance', state: 'closed', propagation: { ok: true } },
      });
  });

  it('runs a real nested goal without root reconciliation and exports its current final verdict', async () => {
    const childSteps = [...frame(), ...aligned(), ...delivery(), ...accepted(), ...clear()].map(
      (step) => ({
        ...step,
        card: 'card-a',
        args:
          step.tool === 'write'
            ? {
                ...(step.args as object),
                path: `record:///${['alignment', 'integrated-acceptance', 'debt-assessment'].includes(step.node) ? 'review.md' : 'status.md'}?card=card-a`,
              }
            : step.args,
      }),
    );
    const f = fixture([
      ...frame(),
      ...aligned(),
      activate(),
      ...childSteps,
      ...decision('deliver', 'blocked', 'Goal complete; root still needs integration input.'),
    ]);
    f.child('goal');
    await expect((await f.launch()).settlement.promise).resolves.toMatchObject({
      status: 'blocked',
    });
    expect(f.cards.read('card-a')!.lifecycle).toMatchObject({
      status: 'done',
      result: { node_id: 'debt-assessment', executor: { agent: 'reviewer' } },
    });
    expect(
      f.requests
        .filter((input) => selectedNode(input).card === 'card-a')
        .some((input) => selectedNode(input).node === 'objective-assessment'),
    ).toBe(false);
  });

  it('resumes BLOCKED architecture system review and routes final notifications to Executor assessment without redrafting', async () => {
    const f = fixture([
      ...frame(),
      ...aligned(),
      activate(),
      ...decision(
        'draft',
        'ready_for_component_review',
        'Bounded interface design with implementation rationale.',
        'card-a',
      ),
      ...decision(
        'component-review',
        'approved',
        'Component ownership/interface examined against source.',
        'card-a',
      ),
      ...decision(
        'system-review',
        'blocked',
        'Need deployment boundary evidence for system fit.',
        'card-a',
      ),
      ...decision('deliver', 'blocked', 'Supply architecture boundary evidence.'),
    ]);
    f.child('architecture');
    await (
      await f.launch()
    ).settlement.promise;
    const boundary = f.requests.length;
    const steps = [
      ...resumeDelivery(),
      activate(),
      ...decision(
        'resume-assess',
        'system_review',
        'Boundary evidence supplied; draft and component examination unchanged.',
        'card-a',
      ),
      ...decision(
        'system-review',
        'approved',
        'System fit now evidenced; exact component review remains applicable.',
        'card-a',
      ),
      ...decision(
        'resume-assess',
        'system_review',
        'Delivered notification affects system evidence only.',
        'card-a',
      ),
      ...decision(
        'system-review',
        'approved',
        'Final current system judgment incorporates delivered boundary correction.',
        'card-a',
      ),
      ...decision('deliver', 'blocked', 'Architecture complete; parent remains incomplete.'),
    ];
    steps[6]!.before = async () => {
      await f.supervisor.submitNotification(
        testNotificationAuthority(),
        'card-a',
        {
          id: '22222222-2222-4222-8222-222222222222',
          content: 'Clarified system boundary evidence, assess before closing.',
          created_at: new Date().toISOString(),
        },
        'normal',
      );
    };
    f.script(steps);
    await expect((await f.launch()).settlement.promise).resolves.toMatchObject({
      status: 'blocked',
    });
    const resumed = f.requests
      .slice(boundary)
      .filter((input) => selectedNode(input).card === 'card-a');
    expect(
      resumed.some(
        (input) =>
          selectedNode(input).node === 'draft' || selectedNode(input).node === 'component-review',
      ),
    ).toBe(false);
    expect(
      resumed.filter((input) => selectedNode(input).node === 'resume-assess').at(-1)!.sessionId,
    ).toBe('agent:executor:card-a');
    expect(
      JSON.stringify(
        resumed.filter((input) => selectedNode(input).node === 'resume-assess').at(-1)!
          .providerConversation,
      ),
    ).toContain('Clarified system boundary evidence');
    expect(f.cards.read('card-a')!.lifecycle).toMatchObject({
      status: 'done',
      result: { node_id: 'system-review', executor: { agent: 'reviewer' } },
    });
  });

  it('uses actual Stop ownership then STOPPED assessment without replaying the interrupted provider turn', async () => {
    const entered = deferred<void>();
    const f = fixture([
      {
        ...author('frame-plan', 'Must never be written after interrupted provider.'),
        before: async (_input, signal) => {
          entered.resolve();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        },
      },
    ]);
    const owner = await f.launch();
    await entered.promise;
    await expect(f.supervisor.stopProject()).resolves.toMatchObject({
      status: 'stopped',
      contained: true,
    });
    await expect(owner.settlement.promise).rejects.toThrow('stopped');
    // Stop contains execution; the next explicit Run owns durable running-chain recovery.
    expect(f.cards.read('project')!.lifecycle.status).toBe('running');
    const inputId = '00000000-0000-4000-8000-000000000031';
    const sessionId = 'agent:planner:project' as const;
    appendActivationMarker({ projectRoot: f.root }, sessionId, {
      event: 'activation_open',
      instructions: { kind: 'unavailable', reason: 'not_recorded' },
      agent_name: 'planner',
      card_id: 'project',
      input_id: inputId,
    });
    const bytes = canonicalJson(OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE);
    appendLlmTurnToolCallBatch(
      { projectRoot: f.root },
      { inputId, sessionId, agentName: 'planner' } as never,
      {
        id: 'interrupted-read',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"work:///"}' },
      },
      {
        resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
        resultPolicyTemplateBytes: bytes,
        resultPolicyTemplateSha256: sha256Hex(bytes),
      },
    );
    f.script([
      ...decision(
        'resume-assess',
        'frame',
        'Actual Stop interrupted framing; no completed analysis or approval is inferred.',
      ),
      ...frame(),
      ...aligned(),
      ...delivery(),
      ...objective(),
      ...accepted(),
      ...clear(),
    ]);
    await expect((await f.launch()).settlement.promise).resolves.toMatchObject({ status: 'done' });
    expect(f.requests.filter((input) => selectedNode(input).node === 'frame-plan')).toHaveLength(3);
    const rows = readConversation(f.root, 'agent:planner:project').sourceRows;
    expect(
      rows.filter(
        (row) => row.kind === 'tool_call' && row.content.includes('Must never be written'),
      ),
    ).toHaveLength(0);
    const uncertain = rows.filter(
      (row) => row.kind === 'tool_result' && row.tool_call_id === 'interrupted-read',
    );
    expect(uncertain).toHaveLength(1);
    expect(JSON.parse(uncertain[0]!.content)).toMatchObject({
      success: false,
      data: { outcome_unknown: true },
    });
    expect(
      rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'interrupted-read'),
    ).toHaveLength(1);
  });

  it('feeds accepted history beside clean draft, suppresses unchanged feeds and retains current task through actual compaction with explicit historical read on reentry', async () => {
    const f = fixture([
      ...frame(),
      ...aligned(),
      ...delivery(),
      ...objective(),
      ...decision(
        'integrated-acceptance',
        'blocked',
        'Verification evidence unavailable; alignment remains applicable.',
      ),
    ]);
    await (
      await f.launch()
    ).settlement.promise;
    const prepared = f.requests
      .filter((input) => selectedNode(input).node === 'integrated-acceptance')
      .at(-1)!;
    const first = f.requests.find((input) => selectedNode(input).node === 'integrated-acceptance')!;
    expect(JSON.stringify(first.providerConversation)).toContain('Plan covers switch order');
    expect(JSON.stringify(first.providerConversation)).toContain('Objective examination');
    const process = f.compiled.cardTypes.get('project')!;
    const node = process.states.get('node:integrated-acceptance')!;
    if (node.kind !== 'node') throw new Error('Missing review');
    const supplier = bootstrapContextSupplier(f.cards, f.cards.read('project')!, node);
    const once = supplier({
      inputId: randomUUID(),
      conversation: readConversation(f.root, prepared.sessionId),
    });
    appendConversationBatch({ projectRoot: f.root }, [...once.rows]);
    const twice = supplier({
      inputId: randomUUID(),
      conversation: readConversation(f.root, prepared.sessionId),
    });
    expect(twice.rows).toEqual([]);
    expect(twice.recordBlocks).toEqual(once.recordBlocks);
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
      appendActivationMarker({ projectRoot: f.root }, prepared.sessionId, {
        event: 'activation_open',
        instructions: { kind: 'unavailable', reason: 'not_recorded' },
        agent_name: 'reviewer',
        card_id: 'project',
        input_id: inputId,
      });
      appendConversationBatch({ projectRoot: f.root }, [
        buildUserContextMessage(prepared.sessionId, inputId, 'process_transition', 0, {
          role: 'user',
          content: 'Later ordinary factual narrative. '.repeat(700),
        }),
      ]);
    }
    const source = readCurrentConversationSegment(f.root, prepared.sessionId)!;
    const preparedCompaction = prepareCompaction(
      { ...testAutonomousCompaction.compactionConfig, tail_fraction: 0.05 },
      prepared.systemPrompt,
      prepared.tools,
      24000,
      200,
    );
    const preparedContext = buildPreparedInvocationContext({
      ...prepared.preparedContext,
      instructionText: prepared.systemPrompt,
      terminalToolNames: prepared.terminalToolNames,
      compiledTools: prepared.compiledToolContracts,
      preparedCompaction,
    });
    const input = {
      ...prepared,
      preparedCompaction,
      preparedContext,
      providerConversation: providerConversationProjection(
        source.conversation,
        composedPreparedBlocks(preparedContext),
      ),
    };
    const summaryRequests: unknown[] = [];
    const compacted = await compact({
      strategy: 'preventive',
      summaryRefusal: null,
      conversations: { projectRoot: f.root },
      input,
      summarizerProvider: {
        candidate: { provider: 'test', account: null, model: 'test-model' },
        contextWindowTokens: 100000,
        maxOutputTokens: 10000,
        materializeImage: async () => {
          throw new Error('No images');
        },
        serializeSummaryRequest: deterministicSummarySerialization,
        completeTurn: async (request) => {
          summaryRequests.push(request);
          return {
            result: {
              kind: 'message',
              content:
                'Historical narrative summarized; exact earlier acceptance must be read for applicability.',
            },
            provider_exchanges: [],
          };
        },
        projectProviderExchanges: () => undefined,
      },
      signal: new AbortController().signal,
      progress: noCompactionProgress,
    });
    expect(compacted.kind).toBe('compacted');
    const successor = readCurrentConversationSegment(f.root, prepared.sessionId)!;
    expect(successor.entry.version).toBe(source.entry.version + 1);
    expect(
      readHistoricalConversationSegment(f.root, prepared.sessionId, source.entry.version).rows,
    ).toEqual(source.rows);
    const successorRequest = {
      ...input,
      providerConversation: providerConversationProjection(
        successor.conversation,
        composedPreparedBlocks(preparedContext),
      ),
    };
    expect(selectedNode(successorRequest).node).toBe('integrated-acceptance');
    expect(
      successorRequest.providerConversation.messages.some(
        (message) =>
          'block_identity' in message && message.block_identity === 'current-bootstrap:project',
      ),
    ).toBe(true);
    f.script([
      ...decision(
        'resume-assess',
        'accept',
        'New verification evidence resumes affected acceptance only.',
      ),
      {
        node: 'integrated-acceptance',
        tool: 'read',
        args: { path: 'record:///review.md?card=project&v=1' },
      },
      ...accepted(),
      ...clear(),
    ]);
    await expect((await f.launch()).settlement.promise).resolves.toMatchObject({
      status: 'done',
      result: { node_id: 'debt-assessment' },
    });
    expect(results(f)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ success: true, data: expect.objectContaining({ version: 1 }) }),
      ]),
    );
    const directory = processEnvironmentEvidence();
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'newloop2-compaction.json'),
        JSON.stringify({ input, summaryRequests, successorRequest }, null, 2),
      );
    }
  });
});

function processEnvironmentEvidence() {
  return process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
}
