import { testPlannerAuthority, testNotificationAuthority } from '../helpers/capability-grants.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { invokeToolForLlm, surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/contracts/index.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import {
  plannerControlToolBinders,
  type PlannerControlProviderContext,
} from '../../src/tools/planner-control-provider.js';
import { ChildInvocationLease } from '../../src/runtime/actors/child-invocation-wait.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { runtimeFailure } from '../helpers/workflow-result.js';
import type { CardRecord, CardStatus } from '../../src/schemas/index.js';
import type { NotificationSubmissionResult } from '../../src/runtime/runtime-api.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { submitNotificationTool } from '../../src/tools/notification-tool.js';
import { queueNotificationInputSchema } from '../../src/contracts/builtin-tool-inputs.js';
import { cardHeadFile } from '../../src/persistence/layout.js';

const PARENT = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD = `${PARENT}-b`;
const roots: string[] = [];
const bindPlannerControl = (context: PlannerControlProviderContext) =>
  bindToolProvider('planner-control', plannerControlToolBinders, context);

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function settleToolForLlm(
  surface: Parameters<typeof invokeToolForLlm>[0],
  name: string,
  args: unknown,
  context: Parameters<typeof invokeToolForLlm>[3],
  signal?: AbortSignal,
) {
  return invokeToolForLlm(surface, name, args, context, signal).then(
    (settlement) =>
      settleToolActionOutcome(
        settlement.kind === 'executed'
          ? settlement.execution.providerOutcome
          : settlement.providerOutcome,
      ).providerResult,
  );
}

describe('planner control provider ownership delegation', () => {
  it.each([
    ['activate_card', { card_id: CHILD }],
    ['activate_card', { card_id: CHILD, instructions: ' \t\n' }],
    ['activate_card', { card_id: CHILD, instructions: 'Direction', parent: PARENT }],
    ['create_card', { type: 'code', title: '', bootstrap_content: 'Brief' }],
    ['create_card', { type: 'code', title: ' \t\n', bootstrap_content: 'Brief' }],
    [
      'create_card',
      { type: 'code', title: 'valid', bootstrap_content: 'Brief', urgency: 'urgent' },
    ],
    ...[
      [`${CHILD},card-b`],
      [` ${CHILD} `],
      [`card-${Array(13).fill('a').join('-')}`],
      [CHILD, `${CHILD},card-b`],
    ].map((depends_on): [string, Record<string, unknown>] => [
      'create_card',
      { type: 'code', title: 'valid', bootstrap_content: 'Brief', depends_on },
    ]),
    ['edit_card', { card_id: CHILD, title: '' }],
    ['edit_card', { card_id: CHILD, title: ' \t\n' }],
    ['edit_card', { card_id: CHILD, urgency: 'urgent' }],
  ] as Array<[string, Record<string, unknown>]>)(
    'rejects malformed %s arguments before executor/store entry %#',
    async (name, args) => {
      const test = harness();
      const executor = jest.spyOn(test.surface.tools.get(name)!, 'executor');
      const settlement = await invokeToolForLlm(
        test.surface,
        name,
        args,
        testLlmToolInvocationContext({ sessionId: `agent:planner:${PARENT}`, toolName: name }),
      );
      expect(settlement.kind).toBe('rejected_before_execution');
      if (settlement.kind === 'executed') throw new Error('Malformed arguments entered execution.');
      expect(settleToolActionOutcome(settlement.providerOutcome).providerResult).toMatchObject({
        success: false,
      });
      expect(executor).not.toHaveBeenCalled();
      expect(test.store.read).not.toHaveBeenCalled();
      expect(test.store.create).not.toHaveBeenCalled();
      expect(test.store.editCard).not.toHaveBeenCalled();
    },
  );

  it('projects title-only edits and a semantic non-whitespace title pattern into provider schemas', () => {
    const test = harness();
    for (const name of ['create_card', 'edit_card']) {
      const schema = surfaceToolDefinitions(test.surface).find(
        (tool) => tool.function.name === name,
      )!.function.parameters as {
        properties: { title: { pattern: string } };
        required: string[];
      };
      expect(schema.properties).not.toHaveProperty('priority');
      expect(schema.properties).not.toHaveProperty('urgency');
      const pattern = new RegExp(schema.properties.title.pattern);
      for (const invalid of ['', ' ', '\t\n']) expect(pattern.test(invalid)).toBe(false);
      for (const valid of ['meaningful', '  meaningful title  '])
        expect(pattern.test(valid)).toBe(true);
      expect(schema.required.includes('title')).toBe(name === 'create_card');
      expect(schema.required).not.toContain('urgency');
    }
  });

  function harness() {
    const store = {
      read: jest.fn((id: string) => (id === CHILD ? { id: CHILD, type: 'code' } : null)),
      create: jest.fn(),
      editCard: jest.fn(),
      reorderChildren: jest.fn(),
    } as unknown as CardService;
    const activateChild = jest.fn<PlannerControlProviderContext['parentControl']['activateChild']>(
      async ({ childCardId }) => ({
        status: 'done' as const,
        summary: childCardId,
        result: workflowResult('DONE', childCardId),
      }),
    );
    const cancelChild = jest.fn<PlannerControlProviderContext['parentControl']['cancelChild']>(
      async ({ childCardId }) => ({
        card_id: childCardId,
        status: 'cancelled' as const,
        cancelled_card_ids: [childCardId],
      }),
    );
    const reopenChild = jest.fn<PlannerControlProviderContext['parentControl']['reopenChild']>(({ childCardId }) => ({
      card_id: childCardId,
      status: 'changed' as const,
    }));
    const submitNotification = jest.fn<() => Promise<NotificationSubmissionResult>>(async () => ({
      queued: true,
      cardId: CHILD,
      notificationId: '00000000-0000-4000-8000-000000000001',
      interruption: { status: 'not_requested' },
    }));
    const surface = buildInvocationSurfaceFixture('planner', [
      bindPlannerControl({
        agentName: 'planner',
        projectRoot: '/project',
        parentCardId: PARENT,
        authority: testPlannerAuthority(PARENT),
        sessionId: `agent:planner:${PARENT}`,
        store,
        parentControl: { activateChild, cancelChild, reopenChild },
        childCreationTypes: new Set(),
        childActivationTypes: new Set(['code']),
        cardTypeVocabulary: [
          'project',
          'goal',
          'architecture',
          'code',
          'test',
          'doc',
          'data',
          'research',
          'ops',
        ],
      }),
    ]);
    return { store, activateChild, cancelChild, reopenChild, submitNotification, surface };
  }

  it('reserves the exact child lease and delegates activation without card I/O or callbacks', async () => {
    const test = harness();
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolCallId: 'activate',
      toolName: 'activate_card',
    });
    await expect(
      settleToolForLlm(
        test.surface,
        'activate_card',
        { card_id: CHILD, instructions: '  Complete the child task.\n' },
        context,
      ),
    ).resolves.toEqual({ success: true, data: { card_id: CHILD, outcome: 'done', result: workflowResult('DONE', CHILD) } });
    expect(test.activateChild).toHaveBeenCalledWith({
      authority: testPlannerAuthority(PARENT),
      childCardId: CHILD,
      instructions: '  Complete the child task.\n',
      invocation: expect.any(ChildInvocationLease),
    });
    expect(test.store.read).toHaveBeenCalledWith(CHILD);
  });

  it('reports a stopped child activation truthfully as non-success', async () => {
    const test = harness();
    test.activateChild.mockResolvedValueOnce({
      status: 'stopped',
      summary: 'urgent correction interrupted descendant work',
    });
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolCallId: 'activate-stopped',
      toolName: 'activate_card',
    });
    await expect(
      settleToolForLlm(
        test.surface,
        'activate_card',
        { instructions: 'Complete the scoped child task with current evidence.', card_id: CHILD },
        context,
      ),
    ).resolves.toEqual({
      success: false,
      error: `Child card '${CHILD}' activation was stopped.`,
      data: {
        card_id: CHILD,
        outcome: 'stopped',
        summary: 'urgent correction interrupted descendant work',
      },
    });
  });

  it.each(['failed', 'blocked'] as const)('settles a child %s as tool success with only its typed narrative', async (status) => {
    const test = harness();
    const outcome = status === 'failed'
      ? { status, summary: 'Internal narrative is not an outward field.', result: runtimeFailure('Verification failed; partial changes remain and release is unconfirmed.') }
      : { status, summary: 'Internal narrative is not an outward field.', result: workflowResult('BLOCKED', 'Verification blocked pending correction.', {
          records: [{ name: 'status.md', url: `record:///status.md?card=${CHILD}&v=3`, version: 3 }],
        }) };
    test.activateChild.mockResolvedValueOnce(outcome);
    await expect(settleToolForLlm(
      test.surface,
      'activate_card',
      { card_id: CHILD, instructions: 'Complete scoped work.' },
      testLlmToolInvocationContext({ sessionId: `agent:planner:${PARENT}`, toolCallId: `activate-${status}`, toolName: 'activate_card' }),
    )).resolves.toEqual({ success: true, data: { card_id: CHILD, outcome: status, result: outcome.result } });
  });

  it('validates immediate-child identity before reserving or delegating', async () => {
    const test = harness();
    const base = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolName: 'activate_card',
    });
    const reserve = jest.fn(base.childInvocation.reserveChild);
    const context = {
      ...base,
      childInvocation: { ...base.childInvocation, reserveChild: reserve },
    };
    await expect(
      settleToolForLlm(
        test.surface,
        'activate_card',
        {
          instructions: 'Complete the scoped child task with current evidence.',
          card_id: 'card-b',
        },
        context,
      ),
    ).resolves.toMatchObject({ success: false });
    expect(reserve).not.toHaveBeenCalled();
    expect(test.activateChild).not.toHaveBeenCalled();
    expect(test.store.read).not.toHaveBeenCalled();
  });

  it('delegates cancellation owner-first with no target/status/list/dependency read', async () => {
    const test = harness();
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolName: 'cancel_card',
    });
    await expect(
      settleToolForLlm(
        test.surface,
        'cancel_card',
        { card_id: CHILD, reason: 'obsolete' },
        context,
      ),
    ).resolves.toMatchObject({ success: true });
    expect(test.cancelChild).toHaveBeenCalledWith({ authority: testPlannerAuthority(PARENT), childCardId: CHILD, reason: 'obsolete' });
    expect(test.store.read).not.toHaveBeenCalled();
  });

  it('delegates reopen owner-first and returns only the compact changed result', async () => {
    const test = harness();
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolName: 'reopen_card',
    });
    await expect(
      settleToolForLlm(test.surface, 'reopen_card', { card_id: CHILD }, context),
    ).resolves.toEqual({ success: true, data: { card_id: CHILD, status: 'changed' } });
    expect(test.reopenChild).toHaveBeenCalledWith({ authority: testPlannerAuthority(PARENT), childCardId: CHILD });
    expect(test.store.read).not.toHaveBeenCalled();
  });

  it('rejects non-child and noncanonical reopen arguments before owner delegation', async () => {
    const test = harness();
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolName: 'reopen_card',
    });
    await expect(
      settleToolForLlm(test.surface, 'reopen_card', { card_id: 'card-b' }, context),
    ).resolves.toMatchObject({ success: false });
    await expect(
      settleToolForLlm(
        test.surface,
        'reopen_card',
        { card_id: CHILD, reason: 'alias forbidden' },
        context,
      ),
    ).resolves.toMatchObject({ success: false });
    expect(test.reopenChild).not.toHaveBeenCalled();
  });

  it('authorizes the current parent before zero-change reorder without notification follow-on work', async () => {
    const test = harness();
    jest.mocked(test.store.read).mockReturnValue({ id: PARENT } as CardRecord);
    jest.mocked(test.store.reorderChildren).mockReturnValue({ ok: true, changed: 0 });
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolName: 'reorder_child',
    });
    await expect(
      settleToolForLlm(test.surface, 'reorder_child', { orderedChildIds: [] }, context),
    ).resolves.toEqual({ success: true, data: { parent_id: PARENT, changed: 0 } });
    expect(test.store.reorderChildren).toHaveBeenCalledTimes(1);
    expect(test.store.reorderChildren).toHaveBeenCalledWith(PARENT, []);
    expect(test.store.read).toHaveBeenCalledWith(PARENT);
    expect(test.submitNotification).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        queued: true as const,
        cardId: CHILD,
        notificationId: '00000000-0000-4000-8000-000000000001',
        interruption: { status: 'not_requested' as const },
      },
      {
        success: true,
        data: {
          queued: true,
          card_id: CHILD,
          notification_id: '00000000-0000-4000-8000-000000000001',
          body: 'body',
          interruption: { status: 'not_requested' },
        },
      },
    ],
    [
      {
        queued: true as const,
        cardId: CHILD,
        notificationId: '00000000-0000-4000-8000-000000000002',
        interruption: { status: 'interrupted' as const, stopped_card_ids: [CHILD] },
      },
      {
        success: true,
        data: {
          queued: true,
          card_id: CHILD,
          notification_id: '00000000-0000-4000-8000-000000000002',
          body: 'body',
          interruption: { status: 'interrupted', stopped_card_ids: [CHILD] },
        },
      },
    ],
    [
      { queued: false as const, reason: 'missing_card' as const, cardId: CHILD },
      {
        success: false,
        error: `Card '${CHILD}' not found.`,
        data: { queued: false, reason: 'missing_card', card_id: CHILD },
      },
    ],
    [
      {
        queued: false as const,
        reason: 'terminal_card' as const,
        cardId: CHILD,
        status: 'cancelled' as const,
      },
      {
        success: false,
        error: `Cannot queue notification for terminal card '${CHILD}' in status 'cancelled'.`,
        data: { queued: false, reason: 'terminal_card', card_id: CHILD, status: 'cancelled' },
      },
    ],
    [
      { queued: false as const, reason: 'activation_closed' as const, cardId: CHILD },
      {
        success: false,
        error: `Cannot queue notification for card '${CHILD}': its current activation is closed to new notifications.`,
        data: { queued: false, reason: 'activation_closed', card_id: CHILD },
      },
    ],
  ])(
    'maps global notification owner result %# exactly without a card binder',
    async (ownerResult, expected) => {
      const test = harness();
      test.submitNotification.mockResolvedValue(ownerResult);
      await expect(
        submitNotificationTool(
          testNotificationAuthority(),
          { card_id: CHILD, kind: 'context', body: 'body', urgency: 'normal' },
          test.submitNotification,
          new AbortController().signal,
        ).then((outcome) => settleToolActionOutcome(outcome).providerResult),
      ).resolves.toEqual(expected);
      expect(test.submitNotification).toHaveBeenCalledTimes(1);
      if (!ownerResult.queued && ownerResult.reason === 'activation_closed')
        expect(JSON.stringify(expected)).not.toMatch(/status|winner/);
    },
  );

  it('requires the exact lowercase global notification urgency contract', () => {
    expect(
      queueNotificationInputSchema.safeParse({ card_id: CHILD, kind: 'context', body: 'body' })
        .success,
    ).toBe(false);
    expect(
      queueNotificationInputSchema.safeParse({
        card_id: CHILD,
        kind: 'context',
        body: 'body',
        urgency: 'URGENT',
      }).success,
    ).toBe(false);
    expect(harness().surface.tools.has('queue_notification')).toBe(false);
  });

  it('settles a pre-aborted activation as rejected before execution', async () => {
    const test = harness();
    const interruption = new RuntimeStoppedInterruption();
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolName: 'activate_card',
    });
    const controller = new AbortController();
    controller.abort(interruption);
    await expect(
      settleToolForLlm(
        test.surface,
        'activate_card',
        { instructions: 'Complete the scoped child task with current evidence.', card_id: CHILD },
        context,
        controller.signal,
      ),
    ).resolves.toEqual({ success: false, error: 'Tool execution was cancelled before entry.' });
    expect(test.activateChild).not.toHaveBeenCalled();
    expect(test.store.read).not.toHaveBeenCalled();
  });

  it('settles a pre-aborted reopen as rejected before execution', async () => {
    const test = harness();
    const interruption = new RuntimeStoppedInterruption();
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolName: 'reopen_card',
    });
    const controller = new AbortController();
    controller.abort(interruption);
    await expect(
      settleToolForLlm(test.surface, 'reopen_card', { card_id: CHILD }, context, controller.signal),
    ).resolves.toEqual({ success: false, error: 'Tool execution was cancelled before entry.' });
    expect(test.reopenChild).not.toHaveBeenCalled();
    expect(test.store.read).not.toHaveBeenCalled();
  });

  it('does not convert reopen publication uncertainty into an operational tool result', async () => {
    const test = harness();
    const failure = new PublicationOutcomeUnknownError();
    test.reopenChild.mockImplementationOnce(() => {
      throw failure;
    });
    const context = testLlmToolInvocationContext({
      sessionId: `agent:planner:${PARENT}`,
      toolName: 'reopen_card',
    });
    await expect(
      settleToolForLlm(test.surface, 'reopen_card', { card_id: CHILD }, context),
    ).rejects.toBe(failure);
  });

  function editHarness(status: CardStatus) {
    const root = mkdtempSync(join(tmpdir(), `planner-edit-${status}-`));
    roots.push(root);
    initProjectTree(root);
    const store = new CardService(root);
    const child = store.create({
      type: 'code',
      parent: 'project',
      title: 'Original',
      bootstrap_content: 'Brief',
      created_by: 'analyst',
      depends_on: [],
    });
    if (status === 'changed') {
      store.setStatus(child.id, 'running');
      store.commitActivationOutcome(
        child.id,
        { status: 'blocked', summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') },
        '2026-08-15T00:00:00.000Z',
      );
      store.setStatus(child.id, 'changed');
    } else if (status === 'running') store.setStatus(child.id, 'running');
    else if (status === 'stopped') {
      store.setStatus(child.id, 'running');
      store.stopRunning(child.id);
    } else if (status === 'cancelled') store.setStatus(child.id, 'cancelled');
    else if (status === 'done' || status === 'failed' || status === 'blocked') {
      store.setStatus(child.id, 'running');
      if (status === 'done')
        store.commitActivationOutcome(
          child.id,
          { status, summary: 'done', result: workflowResult('DONE', 'done') },
          '2026-08-15T00:00:00.000Z',
        );
      else if (status === 'failed')
        store.commitActivationOutcome(
          child.id,
          { status, summary: 'failed', result: runtimeFailure('failed') },
          '2026-08-15T00:00:00.000Z',
        );
      else
        store.commitActivationOutcome(
          child.id,
          { status, summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') },
          '2026-08-15T00:00:00.000Z',
        );
    }
    const provider = bindPlannerControl({
      agentName: 'planner',
      projectRoot: root,
      parentCardId: 'project',
      authority: testPlannerAuthority('project'),
      sessionId: 'agent:planner:project',
      store,
      parentControl: {
        activateChild: jest.fn() as never,
        cancelChild: jest.fn() as never,
        reopenChild: jest.fn() as never,
      },
      childCreationTypes: new Set(['code']),
      childActivationTypes: new Set(),
      cardTypeVocabulary: [
        'project',
        'goal',
        'architecture',
        'code',
        'test',
        'doc',
        'data',
        'research',
        'ops',
      ],
    });
    const surface = buildInvocationSurfaceFixture('planner', [provider]);
    return { root, store, child: store.read(child.id)!, surface };
  }

  function invokeCreate(
    surface: ReturnType<typeof buildInvocationSurfaceFixture>,
    dependencies: { depends_on?: string[] },
  ) {
    return invokeToolForLlm(
      surface,
      'create_card',
      { type: 'code', title: 'Dependent work', bootstrap_content: 'Brief', ...dependencies },
      testLlmToolInvocationContext({ sessionId: 'agent:planner:project', toolName: 'create_card' }),
    );
  }

  it.each(['omitted', 'empty', 'sibling'] as const)(
    'creates with %s dependencies through the canonical owner',
    async (kind) => {
      const test = editHarness('backlog');
      const depends_on = kind === 'sibling' ? [test.child.id] : [];
      const settlement = await invokeCreate(
        test.surface,
        kind === 'omitted' ? {} : { depends_on },
      );
      expect(settlement.kind).toBe('executed');
      if (settlement.kind !== 'executed') throw new Error('Expected creation execution.');
      const result = settleToolActionOutcome(settlement.execution.providerOutcome).providerResult;
      expect(result.success).toBe(true);
      const id = (result.data as { card: { id: string } }).card.id;
      expect(test.store.read(id)).toMatchObject({ depends_on });
      expect(test.store.read('project')!.child_membership).toContain(id);
    },
  );

  it('rejects malformed input then creates corrected work on the same canonical surface', async () => {
    const test = editHarness('backlog');
    const executor = jest.spyOn(test.surface.tools.get('create_card')!, 'executor');
    const read = jest.spyOn(test.store, 'read');
    const create = jest.spyOn(test.store, 'create');
    const rejected = await invokeCreate(test.surface, {
      depends_on: [test.child.id, `${test.child.id},card-b`],
    });
    expect(rejected.kind).toBe('rejected_before_execution');
    expect(executor).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const corrected = await invokeCreate(test.surface, { depends_on: [test.child.id] });
    expect(corrected.kind).toBe('executed');
    if (corrected.kind !== 'executed') throw new Error('Expected corrected execution.');
    const result = settleToolActionOutcome(corrected.execution.providerOutcome).providerResult;
    expect(result.success).toBe(true);
    const id = (result.data as { card: { id: string } }).card.id;
    expect(test.store.read(id)).toMatchObject({ depends_on: [test.child.id] });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'non-sibling', 'project'] as const)(
    'keeps %s dependency rejection in the semantic owner without creation',
    async (kind) => {
      const test = editHarness('backlog');
      const goal = test.store.create({
        type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'Brief',
        created_by: 'analyst', depends_on: [],
      });
      const nested = test.store.create({
        type: 'code', parent: goal.id, title: 'Nested', bootstrap_content: 'Brief',
        created_by: 'analyst', depends_on: [],
      });
      const dependency = kind === 'missing' ? 'card-zz' : kind === 'project' ? 'project' : nested.id;
      const create = jest.spyOn(test.store, 'create');
      const read = jest.spyOn(test.store, 'read');
      const settlement = await invokeCreate(test.surface, { depends_on: [dependency] });
      expect(settlement.kind).toBe('executed');
      if (settlement.kind !== 'executed') throw new Error('Expected semantic execution.');
      expect(settleToolActionOutcome(settlement.execution.providerOutcome).providerResult)
        .toMatchObject({
          success: false,
          error: expect.stringContaining(kind === 'missing' ? 'not found' : 'immediate child'),
        });
      expect(read).toHaveBeenCalledWith(dependency);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('does not classify corrupt selected dependency data as malformed tool arguments', async () => {
    const test = editHarness('backlog');
    writeFileSync(cardHeadFile(test.root, test.child.id), '{}\n');
    const create = jest.spyOn(test.store, 'create');
    await expect(invokeCreate(test.surface, { depends_on: [test.child.id] }))
      .rejects.toBeInstanceOf(z.ZodError);
    expect(create).not.toHaveBeenCalled();
  });

  function invokeEdit(
    surface: ReturnType<typeof buildInvocationSurfaceFixture>,
    args: Record<string, unknown>,
  ) {
    return settleToolForLlm(
      surface,
      'edit_card',
      args,
      testLlmToolInvocationContext({ sessionId: 'agent:planner:project', toolName: 'edit_card' }),
    );
  }

  it(
    'accepts meaningful title bytes without ranking metadata in create/edit',
    async () => {
      const test = editHarness('backlog');
      const created = await settleToolForLlm(
        test.surface,
        'create_card',
        {
          type: 'code',
          title: '  meaningful created title  ',
          bootstrap_content: '  Brief  ',
        },
        testLlmToolInvocationContext({
          sessionId: 'agent:planner:project',
          toolName: 'create_card',
        }),
      );
      expect(created).toMatchObject({
        success: true,
        data: { card: { title: '  meaningful created title  ' } },
      });
      const childId = (created.data as { card: { id: string } }).card.id;
      expect(test.store.read(childId)).toMatchObject({
        title: '  meaningful created title  ',
      });
      await expect(
        invokeEdit(test.surface, {
          card_id: test.child.id,
          title: '  meaningful edited title  ',
        }),
      ).resolves.toMatchObject({
        success: true,
        data: { card: { title: '  meaningful edited title  ' } },
      });
      expect(test.store.read(test.child.id)).toMatchObject({
        title: '  meaningful edited title  ',
      });
    },
  );

  it.each(['blocked', 'failed'] as const)(
    'keeps an equal-value %s child unchanged without adding a version',
    async (status) => {
      const test = editHarness(status);
      const before = test.store.listCardVersions(test.child.id);
      await expect(
        invokeEdit(test.surface, { card_id: test.child.id, title: test.child.title }),
      ).resolves.toMatchObject({
        success: true,
        data: { card: { status, title: test.child.title } },
      });
      expect(test.store.read(test.child.id)).toEqual(test.child);
      expect(test.store.listCardVersions(test.child.id)).toEqual(before);
    },
  );

  it.each(['blocked', 'failed'] as const)(
    'corrects and changes a %s child through one delegated edit',
    async (status) => {
      const test = editHarness(status);
      await expect(
        invokeEdit(test.surface, { card_id: test.child.id, title: 'Corrected' }),
      ).resolves.toMatchObject({
        success: true,
        data: { card: { status: 'changed', title: 'Corrected' } },
      });
      expect(test.store.read(test.child.id)).toMatchObject({
        title: 'Corrected',
        lifecycle: { status: 'changed' },
      });
    },
  );

  it.each(['backlog', 'changed', 'stopped'] as const)(
    'preserves %s lifecycle for a real edit',
    async (status) => {
      const test = editHarness(status);
      await expect(
        invokeEdit(test.surface, { card_id: test.child.id, title: 'Retitled' }),
      ).resolves.toMatchObject({ success: true, data: { card: { status, title: 'Retitled' } } });
      expect(test.store.read(test.child.id)).toMatchObject({ title: 'Retitled', lifecycle: { status } });
    },
  );

  it.each(['running', 'done', 'cancelled'] as const)(
    'rejects a %s child before editing',
    async (status) => {
      const test = editHarness(status);
      const edit = jest.spyOn(test.store, 'editCard');
      await expect(
        invokeEdit(test.surface, { card_id: test.child.id, title: 'Rejected' }),
      ).resolves.toMatchObject({ success: false, error: expect.stringContaining(status) });
      expect(edit).not.toHaveBeenCalled();
    },
  );

  it('delegates once without a provider-side status call', async () => {
    const blocked = {
      id: CHILD,
      type: 'code',
      title: 'Original',
      lifecycle: { status: 'blocked' },
    } as unknown as CardRecord;
    const updated = {
      ...blocked,
      title: 'Corrected',
      lifecycle: { status: 'changed' },
    } as CardRecord;
    const setStatus = jest.fn();
    const store = { read: jest.fn(() => blocked), editCard: jest.fn(() => updated), setStatus };
    const surface = buildInvocationSurfaceFixture('planner', [
      bindPlannerControl({
        agentName: 'planner',
        projectRoot: '/project',
        parentCardId: PARENT,
        authority: testPlannerAuthority(PARENT),
        sessionId: `agent:planner:${PARENT}`,
        store: store as unknown as CardService,
        parentControl: {
          activateChild: jest.fn() as never,
          cancelChild: jest.fn() as never,
          reopenChild: jest.fn() as never,
        },
        childCreationTypes: new Set(),
        childActivationTypes: new Set(),
        cardTypeVocabulary: [
          'project',
          'goal',
          'architecture',
          'code',
          'test',
          'doc',
          'data',
          'research',
          'ops',
        ],
      }),
    ]);
    await expect(
      invokeEdit(surface, { card_id: CHILD, title: 'Corrected' }),
    ).resolves.toMatchObject({ success: true, data: { card: { status: 'changed' } } });
    expect(store.editCard).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();
  });
});
