import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { projectWorkflowPresentation } from '../../src/runtime/card-process/workflow-presentation-projection.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('literal action inputs through selected YAML and workflow compilation', () => {
  it.each(['action', '${ACTION_KIND}'])(
    'does not interpolate node or hook shell fields with kind %s while ordinary configuration still expands',
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'action-literal-interpolation-'));
      roots.push(root);
      const config = structuredClone(TEST_SAIVAGE_CONFIG);
      const workflow = config.card_types.code!.workflow;
      const execution = {
        kind: 'action' as const,
        action: 'shell.run',
        contract_version: 1 as const,
        config: {
          script: 'printf "%s\\n" "${NAME}" "$@"',
          cwd: '${NAME}',
          env: { LABEL: '${NAME}' },
          artifacts: ['reports/result.txt'],
          timeout_ms: 1000,
          terminate_grace_ms: 0,
        },
        inputs: { args: { literal: ['${NAME}', '${UNSET_ACTION_ONLY}'] } },
      };
      workflow.nodes.check = {
        execution,
        records: {},
        edges: Object.fromEntries(
          ['passed', 'failed', 'signalled', 'timed_out'].map((outcome) => [
            outcome,
            { target: { node: 'execute' } },
          ]),
        ),
      };
      workflow.entries.BACKLOG = { node: 'check' };
      workflow.after_activation_commit = { statuses: ['done'], execution };
      config.server.host = '${HOST}';
      config.providers.test!.baseUrl = '${ENDPOINT}';
      const expected = structuredClone(execution);
      Object.assign(execution, { kind }); // Raw YAML may select its discriminator from ordinary env.
      const secretFixture = 'sk-proj-' + 'not-a-real-credential-'.repeat(4);
      const loaded = createTestConfigAuthority(root, {
        config,
        environment: {
          NAME: secretFixture,
          ACTION_KIND: 'action',
          HOST: '127.0.0.1',
          ENDPOINT: 'https://fixture.invalid/v1',
        },
      }).loadEffective();

      expect(loaded.warnings).toEqual([]);
      expect(loaded.config.server.host).toBe('127.0.0.1');
      expect(loaded.config.providers.test!.baseUrl).toBe('https://fixture.invalid/v1');
      const effective = loaded.config.card_types.code!.workflow;
      expect(effective.nodes.check!.execution).toEqual(expected);
      expect(effective.after_activation_commit!.execution).toEqual(expected);
      const compiled = loaded.workflows.cardTypes.get('code')!;
      const node = compiled.states.get('node:check')!;
      if (node.kind !== 'node' || node.execution.kind !== 'action') {
        throw new Error('Expected compiled shell action.');
      }
      for (const action of [node.execution, compiled.afterActivationCommit!.execution]) {
        expect(action.config).toEqual(expected.config);
        expect(action.inputs).toEqual(expected.inputs);
      }
      // No ambient value entered effective facts, compiler output or its public projection.
      expect(JSON.stringify(loaded.config)).not.toContain(secretFixture);
      expect(JSON.stringify([...loaded.workflows.cardTypes])).not.toContain(secretFixture);
      expect(JSON.stringify(loaded.warnings)).not.toContain(secretFixture);
      expect(JSON.stringify(projectWorkflowPresentation(compiled))).not.toContain(secretFixture);
    },
  );
});
