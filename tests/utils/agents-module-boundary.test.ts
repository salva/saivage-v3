import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as agentsIndex from '../../src/agents/index.js';
import * as analystApi from '../../src/agents/analyst-api.js';
import * as configApi from '../../src/agents/config-api.js';
import * as executionApi from '../../src/agents/execution-api.js';
import * as sessionApi from '../../src/agents/session-api.js';
import * as toolApi from '../../src/agents/tool-api.js';
import { loadConfig, saivageConfigSchema } from '../../src/agents/config-schema.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';
import { SkillsEngine } from '../../src/agents/skills-engine.js';

describe('agents module ownership boundary', () => {
  it('uses explicit exports instead of broad wildcard package re-exports', () => {
    const source = readFileSync(join(process.cwd(), 'src/agents/index.ts'), 'utf8');
    expect(source).not.toMatch(/export\s+\*\s+from/);
  });

  it('keeps the package root limited to stable configuration and execution facades', () => {
    expect(agentsIndex.loadConfig).toBe(loadConfig);
    expect(agentsIndex.saivageConfigSchema).toBe(saivageConfigSchema);
    expect(agentsIndex.AgentAdapter).toBe(AgentAdapter);
    expect(agentsIndex.FakeAgentAdapter).toBe(FakeAgentAdapter);
    expect(agentsIndex.SkillsEngine).toBe(SkillsEngine);
  });

  it('publishes explicit API modules for analyst, session, tool, config, and execution consumers', () => {
    expect(configApi.loadConfig).toBe(loadConfig);
    expect(sessionApi.listSessions).toBeDefined();
    expect(sessionApi.readLatestLlmExchange).toBeDefined();
    expect(analystApi.getAnalystHandler).toBeDefined();
    expect(analystApi.GLOBAL_ANALYST_SESSION_ID).toBe('analyst');
    expect(toolApi.evaluateAuthz).toBeDefined();
    expect(toolApi.ANALYST_TOOL_DEFINITIONS).toBeDefined();
    expect(executionApi.AgentAdapter).toBe(AgentAdapter);
    expect(executionApi.FakeAgentAdapter).toBe(FakeAgentAdapter);
    expect(executionApi.SkillsEngine).toBe(SkillsEngine);
  });

  it('does not export implementation-facing analyst/session/tool helpers from the public package index', () => {
    expect('appendActivateCardToolResultOnce' in agentsIndex).toBe(false);
    expect('AnalystHandler' in agentsIndex).toBe(false);
    expect('getAnalystHandler' in agentsIndex).toBe(false);
    expect('GLOBAL_ANALYST_SESSION_ID' in agentsIndex).toBe(false);
    expect('create_card' in agentsIndex).toBe(false);
    expect('ANALYST_TOOL_DEFINITIONS' in agentsIndex).toBe(false);
    expect('evaluateAuthz' in agentsIndex).toBe(false);
    expect('buildExecutorPrompt' in agentsIndex).toBe(false);
    expect('ModelRouter' in agentsIndex).toBe(false);
    expect('createLlmClient' in agentsIndex).toBe(false);
    expect('invokeWithRecovery' in agentsIndex).toBe(false);
  });
});
