import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { workflowOperatorApiContracts, WorkflowPresentationSchema } from '../../src/contracts/operator-api-workflows.js';
import { buildWorkflowOperatorContractHandlers } from '../../src/server/routes/operator-workflow-handlers.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import type { CompiledRuntimeWorkflows } from '../../src/runtime/runtime-api.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function fixture() {
  const app = Fastify({ logger: false }); apps.push(app);
  const get = jest.fn((type: string) => TEST_WORKFLOWS.cardTypes.get(type));
  const workflows = { ...TEST_WORKFLOWS, cardTypes: { get, values() { throw new Error('Must not project all types'); } } } as unknown as CompiledRuntimeWorkflows;
  new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'workflow-test-token' }), fatalPort: testApplicationFatalPort, eventLogger: {} as never })
    .mount(app, workflowOperatorApiContracts, buildWorkflowOperatorContractHandlers(workflows));
  return { app, get };
}
describe('authenticated per-type workflow route', () => {
  it('projects only the exact installed type', async () => {
    const { app, get } = fixture();
    const response = await app.inject({ method: 'GET', url: '/api/workflows/code/presentation', headers: { authorization: 'Bearer workflow-test-token' } });
    expect(response.statusCode).toBe(200);
    expect(WorkflowPresentationSchema.parse(response.json()).card_type).toBe('code');
    expect(get.mock.calls).toEqual([['code']]);
  });
  it('returns strict not-found for an unknown installed type', async () => {
    const { app } = fixture();
    const response = await app.inject({ method: 'GET', url: '/api/workflows/not-installed/presentation', headers: { authorization: 'Bearer workflow-test-token' } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'workflow_type_not_found', card_type: 'not-installed' });
  });
  it('requires operator authentication before reading the artifact', async () => {
    const { app, get } = fixture();
    const response = await app.inject({ method: 'GET', url: '/api/workflows/code/presentation' });
    expect(response.statusCode).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });
});
