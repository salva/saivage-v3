import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Runtime } from '../../src/utils/runtime.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';
import type { PlannerResult, ExecutorResult, ReviewerResult } from '../../src/agents/result-parser.js';
import type { CardRecord, HandoffSummary } from '../../src/schemas/types.js';

class StubAgentRuntime implements AgentRuntime {
  constructor(
    private readonly plannerResult: PlannerResult,
    private readonly executorResult: ExecutorResult,
    private readonly reviewerResult: ReviewerResult,
  ) {}

  invokePlanner(): Promise<PlannerResult> {
    return Promise.resolve(this.plannerResult);
  }

  invokeExecutor(): Promise<ExecutorResult> {
    return Promise.resolve(this.executorResult);
  }

  invokeReviewer(): Promise<ReviewerResult> {
    return Promise.resolve(this.reviewerResult);
  }

  cancelSession(): boolean { return false; }
  forceCancelSession(): boolean { return false; }
  getHandoffSummary(): HandoffSummary | null { return null; }
  getActiveSessionHandoffs(): HandoffSummary[] { return []; }
}

describe('Runtime executor fallback evidence persistence', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-fallback-'));
    initProjectTree(projectRoot);
    mkdirSync(join(projectRoot, 'generated'), { recursive: true });
    mkdirSync(join(projectRoot, 'logs'), { recursive: true });
    writeFileSync(join(projectRoot, 'generated', 'output.txt'), 'generated output\n', 'utf8');
    writeFileSync(join(projectRoot, 'logs', 'command-tail.txt'), 'tail output\n', 'utf8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('stores fallback result evidence and registers generated file artifacts for parent inspection', async () => {
    const plannerResult: PlannerResult = {
      status: 'done',
      created_cards: [{
        id: 'code-1',
        type: 'code',
        title: 'Generate output',
        description: 'Create output file and verify it',
        status: 'backlog',
        depends_on: [],
        priority: 1,
      }],
      updated_cards: [],
    };
    const executorResult: ExecutorResult = {
      card_id: 'code-1',
      status: 'failed',
      error: 'Executor final response was malformed or missing required status; preserved tool evidence via fallback result.',
      summary: 'fallback preserved tool evidence',
      artifacts: [
        {
          type: 'other',
          description: 'Generated file: generated/output.txt',
          retain: true,
          path: 'generated/output.txt',
        },
      ],
      attachments: [
        {
          mime: 'text/plain',
          title: 'command output',
          path: 'logs/command-tail.txt',
        },
      ],
      result: {
        generated_files: ['generated/output.txt'],
        verification_commands: [{
          command: 'npm test -- result-parser',
          process_id: 'proc-55',
          status: 'exited',
          exit_code: 0,
          timed_out: false,
        }],
        artifact_paths: ['generated/output.txt'],
        tool_errors: [],
        parse_failure: {
          message: 'Executor final response was malformed or missing required status; preserved tool evidence via fallback result.',
          raw_response: '{"card_id":"code-1"}',
        },
      },
    };
    const reviewerResult: ReviewerResult = {
      assessment: {
        result: 'fail',
        summary: 'Executor failed as expected for malformed final JSON fallback evidence test',
        achieved: ['Fallback evidence persisted on the card.'],
        missing: [],
        evidence_card_ids: ['code-1'],
      },
    };

    const agentRuntime = new StubAgentRuntime(plannerResult, executorResult, reviewerResult);
    const runtime = new Runtime({
      projectRoot,
      fakeAgentConfig: { mapping: {}, fixtureDir: '' },
    }, agentRuntime);

    await runtime.startup();
    await runtime.dispatchGoal('project');
    await runtime.shutdown();

    const codeCard = runtime.cardStore.read('code-1') as CardRecord;
    expect(codeCard.status).toBe('failed');
    expect(codeCard.result).toEqual(expect.objectContaining({
      generated_files: ['generated/output.txt'],
      verification_commands: [expect.objectContaining({
        command: 'npm test -- result-parser',
        process_id: 'proc-55',
        status: 'exited',
        exit_code: 0,
        timed_out: false,
      })],
      artifact_paths: ['generated/output.txt'],
      parse_failure: expect.objectContaining({ raw_response: '{"card_id":"code-1"}' }),
    }));
    expect(codeCard.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        description: 'Generated file: generated/output.txt',
        path: expect.stringContaining('/.saivage-work/cards/code-1/artifacts/retained/output.txt'),
      }),
    ]));
    expect(codeCard.attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'command output',
        path: expect.stringContaining('/.saivage-work/cards/code-1/attachments/command-tail.txt'),
      }),
    ]));

    const frame = runtime.plannerControl.listFrames().find((entry) => entry.planner_card_id === 'project');
    expect(frame).toBeDefined();
    const dispatch = runtime.plannerControl.listDispatches({ parent_frame_id: frame!.frame_id, target_card_id: 'code-1' })[0];
    expect(dispatch).toBeDefined();
    expect(dispatch.completion?.child_result).toEqual(expect.objectContaining({
      generated_files: ['generated/output.txt'],
      verification_commands: [expect.objectContaining({ command: 'npm test -- result-parser' })],
    }));
    expect(dispatch.completion?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        description: 'Generated file: generated/output.txt',
        path: expect.stringContaining('/.saivage-work/cards/code-1/artifacts/retained/output.txt'),
      }),
    ]));
  });
});
