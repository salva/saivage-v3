import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as agentsIndex from '../../src/agents/index.js';
import {
  loadConfig,
  saivageConfigSchema,
} from '../../src/agents/config-schema.js';
import {
  appendActivateCardToolResultOnce,
  appendMessage,
  findPlannerSessionForCard,
  findUniqueUnresolvedActivateCardToolCall,
  getSession,
  getSessionMessages,
  listSessions,
} from '../../src/agents/session-persistence.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import {
  AnalystHandler,
  getAnalystHandler,
  getOrCreateAnalystSession,
  resetAnalystHandlerCache,
} from '../../src/agents/analyst-handler.js';
import { sanitizeAnalystPayload, sanitizeAnalystText } from '../../src/agents/analyst-sanitization.js';
import {
  buildCardRunsResponse,
  consumeChangedCardActivation,
  injectQueuedSyntheticPlannerNotes,
  markGoalNeedsCorrections,
  normalizeAnalystIssues,
  queueSyntheticPlannerNote,
} from '../../src/agents/analyst-stage6.js';
import {
  create_card,
  diff_card,
  edit_card,
  get_card,
  get_card_history_entry,
  get_tree,
  list_card_history,
  list_cards,
  mark_goal_needs_corrections,
} from '../../src/agents/analyst-tools.js';
import { ANALYST_TOOL_DEFINITIONS } from '../../src/agents/analyst-tool-schemas.js';
import { evaluateAuthz } from '../../src/agents/authz.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';
import { SkillsEngine } from '../../src/agents/skills-engine.js';
import { buildExecutorPrompt, buildPlannerPrompt, buildReviewerPrompt } from '../../src/agents/system-prompt.js';

describe('agents module ownership boundary', () => {
  it('uses explicit exports instead of broad wildcard package re-exports', () => {
    const source = readFileSync(join(process.cwd(), 'src/agents/index.ts'), 'utf8');
    expect(source).not.toMatch(/export\s+\*\s+from/);
  });

  it('exports source-proven runtime/server/tool agent values from the public package index', () => {
    expect(agentsIndex.loadConfig).toBe(loadConfig);
    expect(agentsIndex.saivageConfigSchema).toBe(saivageConfigSchema);
    expect(agentsIndex.appendActivateCardToolResultOnce).toBe(appendActivateCardToolResultOnce);
    expect(agentsIndex.appendMessage).toBe(appendMessage);
    expect(agentsIndex.findPlannerSessionForCard).toBe(findPlannerSessionForCard);
    expect(agentsIndex.findUniqueUnresolvedActivateCardToolCall).toBe(findUniqueUnresolvedActivateCardToolCall);
    expect(agentsIndex.getSession).toBe(getSession);
    expect(agentsIndex.getSessionMessages).toBe(getSessionMessages);
    expect(agentsIndex.listSessions).toBe(listSessions);
    expect(agentsIndex.AgentAdapter).toBe(AgentAdapter);
    expect(agentsIndex.AnalystHandler).toBe(AnalystHandler);
    expect(agentsIndex.getAnalystHandler).toBe(getAnalystHandler);
    expect(agentsIndex.getOrCreateAnalystSession).toBe(getOrCreateAnalystSession);
    expect(agentsIndex.resetAnalystHandlerCache).toBe(resetAnalystHandlerCache);
    expect(agentsIndex.sanitizeAnalystPayload).toBe(sanitizeAnalystPayload);
    expect(agentsIndex.sanitizeAnalystText).toBe(sanitizeAnalystText);
    expect(agentsIndex.buildCardRunsResponse).toBe(buildCardRunsResponse);
    expect(agentsIndex.consumeChangedCardActivation).toBe(consumeChangedCardActivation);
    expect(agentsIndex.injectQueuedSyntheticPlannerNotes).toBe(injectQueuedSyntheticPlannerNotes);
    expect(agentsIndex.markGoalNeedsCorrections).toBe(markGoalNeedsCorrections);
    expect(agentsIndex.normalizeAnalystIssues).toBe(normalizeAnalystIssues);
    expect(agentsIndex.queueSyntheticPlannerNote).toBe(queueSyntheticPlannerNote);
    expect(agentsIndex.create_card).toBe(create_card);
    expect(agentsIndex.diff_card).toBe(diff_card);
    expect(agentsIndex.edit_card).toBe(edit_card);
    expect(agentsIndex.get_card).toBe(get_card);
    expect(agentsIndex.get_card_history_entry).toBe(get_card_history_entry);
    expect(agentsIndex.get_tree).toBe(get_tree);
    expect(agentsIndex.list_card_history).toBe(list_card_history);
    expect(agentsIndex.list_cards).toBe(list_cards);
    expect(agentsIndex.mark_goal_needs_corrections).toBe(mark_goal_needs_corrections);
    expect(agentsIndex.ANALYST_TOOL_DEFINITIONS).toBe(ANALYST_TOOL_DEFINITIONS);
    expect(agentsIndex.evaluateAuthz).toBe(evaluateAuthz);
    expect(agentsIndex.FakeAgentAdapter).toBe(FakeAgentAdapter);
    expect(agentsIndex.SkillsEngine).toBe(SkillsEngine);
    expect(agentsIndex.buildExecutorPrompt).toBe(buildExecutorPrompt);
    expect(agentsIndex.buildPlannerPrompt).toBe(buildPlannerPrompt);
    expect(agentsIndex.buildReviewerPrompt).toBe(buildReviewerPrompt);
  });

  it('does not export same-package-only modules as runtime values from the public package index', () => {
    expect('ModelRouter' in agentsIndex).toBe(false);
    expect('createLlmClient' in agentsIndex).toBe(false);
    expect('invokeWithRecovery' in agentsIndex).toBe(false);
    expect('compactSession' in agentsIndex).toBe(false);
    expect('systemPromptBuilder' in agentsIndex).toBe(false);
  });
});
