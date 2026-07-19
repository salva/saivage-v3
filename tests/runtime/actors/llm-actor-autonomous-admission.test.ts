import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationLLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('prepared conversation LLM admission', () => {
  it.each([
    'analyst:global',
    'planner:project',
    'reviewer:card-a',
    'executor:card-a-b',
  ])('admits canonical session %s at construction', (agentId) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-identity-'));
    roots.push(projectRoot);
    const providerCall = jest.fn<LLMProviderPort['completeTurn']>();
    const shouldCompact = jest.fn<CompactorPort['shouldCompact']>();
    const compact = jest.fn<CompactorPort['compact']>();
    const summarize = jest.fn<LLMProviderPort['completeTurn']>();
    const projectionChanged = jest.fn();

    const actor = new ConversationLLMActor({
      projectRoot,
      agentId,
      provider: { completeTurn: providerCall },
      conversations: { projectRoot },
      compactor: { shouldCompact, compact },
      summarizerProvider: { completeTurn: summarize, projectProviderExchanges: jest.fn() },
      runtimeProjectionChanged: projectionChanged,
    });

    expect(actor.agentId).toBe(agentId);
    expect(readdirSync(projectRoot)).toEqual([]);
    expect(providerCall).not.toHaveBeenCalled();
    expect(shouldCompact).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(projectionChanged).not.toHaveBeenCalled();
  });

  it.each([
    'card:project',
    'processor:project',
    'analyst:test',
    'planner:',
    'planner:card-A',
    'reviewer:card-a-b-c-d-e-f',
    'executor:project:extra',
  ])('rejects noncanonical session %s at construction without side effects', (agentId) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-identity-'));
    roots.push(projectRoot);
    const providerCall = jest.fn<LLMProviderPort['completeTurn']>();
    const shouldCompact = jest.fn<CompactorPort['shouldCompact']>();
    const compact = jest.fn<CompactorPort['compact']>();
    const summarize = jest.fn<LLMProviderPort['completeTurn']>();
    const projectionChanged = jest.fn();

    expect(() => new ConversationLLMActor({
      projectRoot,
      agentId,
      provider: { completeTurn: providerCall },
      conversations: { projectRoot },
      compactor: { shouldCompact, compact },
      summarizerProvider: { completeTurn: summarize, projectProviderExchanges: jest.fn() },
      runtimeProjectionChanged: projectionChanged,
    })).toThrow('Expected an exact canonical conversation session id.');

    expect(readdirSync(projectRoot)).toEqual([]);
    expect(providerCall).not.toHaveBeenCalled();
    expect(shouldCompact).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(projectionChanged).not.toHaveBeenCalled();
  });

  it('rejects cast unprepared input before transition, persistence, projection, or downstream calls', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-autonomous-admission-'));
    roots.push(projectRoot);
    const providerCall = jest.fn<LLMProviderPort['completeTurn']>();
    const shouldCompact = jest.fn<CompactorPort['shouldCompact']>();
    const compact = jest.fn<CompactorPort['compact']>();
    const summarize = jest.fn<LLMProviderPort['completeTurn']>();
    const projectionChanged = jest.fn();
    const actor = new ConversationLLMActor({
      projectRoot,
      agentId: 'planner:project',
      provider: { completeTurn: providerCall },
      conversations: { projectRoot },
      compactor: { shouldCompact, compact },
      summarizerProvider: { completeTurn: summarize, projectProviderExchanges: jest.fn() },
      runtimeProjectionChanged: projectionChanged,
    });
    actor.start();
    projectionChanged.mockClear();
    const input: LlmInvocationInput = {
      inputId: '00000000-0000-4000-8000-000000000001', agentId: actor.agentId, role: 'planner', sessionId: 'planner:project',
      systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [],
      modelParams: { maxTokens: 100 }, capabilityRequest: {}, episodeContext: {},
    };

    await expect(actor.turn(input as never)).rejects.toThrow(/requires prepared compaction/);
    expect(actor.state()).toBe('idle');
    await expect(actor.awaitPendingTurn()).rejects.toThrow(/no pending provider turn/);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toEqual([]);
    expect(projectionChanged).not.toHaveBeenCalled();
    expect(shouldCompact).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(providerCall).not.toHaveBeenCalled();
  });
});
