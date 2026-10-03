import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeInternalSummaryTurn } from '../../src/application/invocation-service-provider.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { AdmissionIntegrityError, LocalExactAdmissionError, NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { buildLlmOptions } from '../../src/agents/llm-options-factory.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { admitSummaryRequest, buildSummaryRequestInput, type AdmittedSummaryRequest } from '../../src/runtime/actors/compaction/summarizer.js';
import { invocationProviderRegistry, chatSuccess } from '../helpers/invocation-provider-fixture.js';

const CANDIDATE = { provider: 'test', account: null, model: 'summary' } as const;
const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('executeInternalSummaryTurn byte reuse', () => {
  it('uses actual successful summary admission, retains U and bytes, and rejects changed hashes or no-fit before fetch', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'internal-summary-turn-'));
    roots.push(projectRoot);
    const registry = invocationProviderRegistry([CANDIDATE]);
    const service = new InvocationService({ projectRoot, registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
    const input = buildSummaryRequestInput({ candidate: CANDIDATE, sourceSessionId: 'agent:planner:project', instruction: 'instruction', items: [] });
    const capabilities = registry.getEffectiveCapabilities(CANDIDATE);
    const pack = (instruction: string): AdmittedSummaryRequest => {
      const plan = buildCandidateRequest({ candidate: CANDIDATE, capabilities, adapter: selectLlmProtocolAdapter(capabilities.transportProtocol), systemPrompt: instruction, providerConversation: input.providerConversation, options: buildLlmOptions(input.agentName, input.tools, input.terminalToolNames, { temperature: 0, max_tokens: 2000 }, undefined, input.inputId) });
      const result = admitSummaryRequest({ serialization: { serializedRequest: plan.request.serializedBody, requestSha256: plan.request.requestHash, estimatedInputTokens: plan.request.estimatedWireInputTokens }, contextUtilizationFraction: .9, contextWindowTokens: capabilities.contextWindowTokens!, maxOutputTokens: capabilities.maxOutputTokens! });
      if (result.kind !== 'admitted') throw new Error('fixture must fit');
      return result;
    };
    const packed = pack(input.systemPrompt);
    const sent: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { sent.push(String(init!.body)); return chatSuccess('summary'); });
    const prepare = service.preparePrimaryRequestAdmission.bind(service);
    jest.spyOn(service, 'preparePrimaryRequestAdmission').mockImplementation((request) => {
      expect(request.contextUtilizationFraction).toBe(.9);
      const result = prepare(request);
      expect(result.bindings.contextUtilizationFraction).toBe(.9);
      return result;
    });
    await expect(executeInternalSummaryTurn(service, input, new AbortController().signal, packed)).resolves.toMatchObject({ result: { kind: 'message', content: 'summary' } });
    expect(sent).toEqual([packed.serializedRequest]);
    expect(createHash('sha256').update(sent[0]!).digest('hex')).toBe(packed.requestSha256);
    await expect(executeInternalSummaryTurn(service, input, new AbortController().signal, pack('different instruction'))).rejects.toBeInstanceOf(AdmissionIntegrityError);
    const tooLarge = { ...input, systemPrompt: 'x'.repeat(500_000) };
    const rejected = await executeInternalSummaryTurn(service, tooLarge, new AbortController().signal, packed).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(LocalExactAdmissionError);
    expect(rejected).toMatchObject({ source: 'internal_summary', reason: 'capacity' });
    expect(sent).toHaveLength(1);
  });
});
