import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  newloop2Fixture,
  author,
  verdict,
  decision,
  selectedNode,
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

jest.setTimeout(30000);
const fixtures: ReturnType<typeof newloop2Fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
function fixture(steps: Step[] = []) {
  const f = newloop2Fixture(steps);
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

describe('newloop2 real owner semantic flows', () => {
  it('completes a small non-code objective with distinct current author and Reviewer evidence and reused sessions', async () => {
    const f = fixture(fresh());
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
      if (type === 'architecture')
        expect(f.record('review.md', 'card-a')!.accepted!.content).toBe(
          'architecture: refreshed current verdict.',
        );
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
