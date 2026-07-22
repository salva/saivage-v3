import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/agents/default-workflow-config.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';

export function invocationProviderRegistry(candidates: readonly Candidate[]): ProviderRegistry {
  if (candidates.length === 0) throw new Error('Invocation provider fixture requires a candidate.');
  const providers: SaivageConfig['providers'] = {};
  for (const candidate of candidates) {
    const existing = providers[candidate.provider];
    const models = existing?.models ?? [];
    providers[candidate.provider] = {
      ...existing,
      models: models.includes(candidate.model) ? models : [...models, candidate.model],
      baseUrl: `https://${candidate.provider}.example.test`,
      apiKey: 'synthetic-test-key',
      capabilities: {
        transportProtocol: 'openai-chat-completions',
        toolsMode: 'native',
        exclusiveToolChoiceSupport: 'native',
        streaming: false,
        contextWindowTokens: 100_000,
        maxOutputTokens: 10_000,
      },
    };
  }
  const first = candidates[0]!;
  return new ProviderRegistry({
    agents:structuredClone(DEFAULT_SAIVAGE_CONFIG.agents) as unknown as SaivageConfig['agents'],analyst_agent:'analyst',
    models: { routes:Object.fromEntries(Object.keys(DEFAULT_SAIVAGE_CONFIG.models.routes).map((name)=>[name,{candidates:[...new Set(candidates.map((candidate)=>candidate.model))],temperature:0.2,max_tokens:2000}])),profiles:{},equivalents:[],failover:{} },
    providers,
    server: { port: 8080, host: '127.0.0.1' },
    compaction: {
      enabled: true,
      input_budget_tokens: 100_000,
      trigger_fraction: 0.8,
      completion_reserve_fraction: 0.2,
      merge_line_fraction: 0.3,
      summary_line_fraction: 0.5,
      escalate_merge_line_fraction: 0.4,
      escalate_summary_line_fraction: 0.6,
      snap: 'compact_straddler',
      summarizer_candidate: first,
    },
    card_types:structuredClone(DEFAULT_SAIVAGE_CONFIG.card_types),
  });
}

export function chatSuccess(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function contextExhausted(): Response {
  return new Response(JSON.stringify({
    error: {
      message: 'structured context rejection',
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      param: 'messages',
    },
  }), { status: 400, headers: { 'content-type': 'application/json' } });
}

export function serverUnavailable(message = 'try again'): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}
