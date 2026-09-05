import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

class AgentCurrentStateUnavailableError extends Error {}
class AgentSessionNotFoundError extends Error {}
class CardAgentScopeNotFoundError extends Error {}

const readLatestProviderExchangePayload = jest.fn();
const admitConversationCatalog = jest.fn(() => ({ currentVersion: 1 }));

jest.unstable_mockModule('../../src/persistence/provider-exchange-log.js', () => ({
  readLatestProviderExchangePayload,
}));
jest.unstable_mockModule('../../src/application/read-models/agent-operator-read-model.js', () => ({
  AgentOperatorReadModelService: class {
    admitConversationCatalog = admitConversationCatalog;
  },
  AgentCurrentStateUnavailableError,
  AgentSessionNotFoundError,
  CardAgentScopeNotFoundError,
}));

const { buildAgentOperatorContractHandlers } = await import('../../src/server/routes/operator-agent-handlers.js');

afterEach(() => {
  jest.restoreAllMocks();
  readLatestProviderExchangePayload.mockReset();
  admitConversationCatalog.mockClear();
});

describe('operator Agent publication uncertainty', () => {
  it('lets provider-exchange publication uncertainty escape the broad read catch', async () => {
    const root = '/unused';
    const failure = new PublicationOutcomeUnknownError();
    readLatestProviderExchangePayload.mockImplementation(() => { throw failure; });
    const handlers = buildAgentOperatorContractHandlers({
      projectRoot: root,
      workflows: {} as never,
      captureExecutingLlmSessionIds: () => new Set(),
    });

    const result = handlers['agents.llmExchange']!({
      params: { id: 'agent:planner:project' },
    } as never);
    expect(readLatestProviderExchangePayload).toHaveBeenCalledWith(root, 'agent:planner:project');
    await expect(result).rejects.toBe(failure);
  });
});
