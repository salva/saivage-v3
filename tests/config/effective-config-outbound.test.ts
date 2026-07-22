import { describe, expect, it } from '@jest/globals';

import { DEFAULT_CARD_PROCESSES, saivageConfigSchema } from '../../src/agents/config-api.js';
import { redactForOutbound, SECRET_REDACTION_PLACEHOLDER } from '../../src/redaction/index.js';
import { OUTBOUND_IDENTITY, OUTBOUND_RAW_MARKER } from '../helpers/outbound-identity-fixtures.js';

describe('effective config outbound projection', () => {
  it('copies every effective namespace exactly while redacting only authoritative secret containers', () => {
    const planningEntryNode = DEFAULT_CARD_PROCESSES.planning.entries.BACKLOG.node;
    const planningNode = DEFAULT_CARD_PROCESSES.planning.nodes[planningEntryNode]!;
    const cardProcesses = {
      ...DEFAULT_CARD_PROCESSES,
      planning: {
        ...DEFAULT_CARD_PROCESSES.planning,
        entries: {
          ...DEFAULT_CARD_PROCESSES.planning.entries,
          BACKLOG: { ...DEFAULT_CARD_PROCESSES.planning.entries.BACKLOG, prompt: 'tok_entry_prompt' },
        },
        nodes: {
          ...DEFAULT_CARD_PROCESSES.planning.nodes,
          [planningEntryNode]: { ...planningNode, prompt: 'token=structural-config-prompt', correction_prompt: 'sk-correction-prompt' },
        },
      },
    };
    const config = saivageConfigSchema.parse({
      models: {
        analyst: 'tok_analyst_model',
        planner: ['sk-planner-model'],
        executor: ['rt_executor_model'],
        reviewer: ['ghu_reviewer_model'],
        temperature: { analyst: 0.1, planner: 0.2, executor: 0.3, reviewer: 0.4, default: 0.5 },
        max_tokens: { analyst: 200, planner: 201, executor: 202, reviewer: 203, default: 204 },
        profiles: { [OUTBOUND_IDENTITY]: { preferred: ['sk-model'], allowed: ['rt-model'] } },
        routing: { analyst: OUTBOUND_IDENTITY, planner: OUTBOUND_IDENTITY, executor: OUTBOUND_IDENTITY, reviewer: OUTBOUND_IDENTITY },
        equivalents: { 'sk-model': ['rt-model', 'ghu_model'] },
        failover: { 'sk-model': ['rt-model'] },
        default: 'tok_default_model',
      },
      providers: {
        tok_provider: {
          priority: 3,
          models: ['sk-model'],
          apiKey: OUTBOUND_RAW_MARKER,
          baseUrl: 'https://tok_provider.example.test/v1?api_key=identity-value',
          authProfile: 'ghu_auth_profile',
          capabilities: {
            transportProtocol: 'openai-responses', toolsMode: 'native', exclusiveToolChoiceSupport: 'parallel_off', streaming: true,
            responsesReasoning: { effort: 'high' }, contextWindowTokens: 1000, maxOutputTokens: 200, quirks: ['tok_quirk'],
          },
          modelCapabilities: { 'sk-model': { toolsMode: 'unsupported', quirks: ['rt_model_quirk'] } },
          accounts: {
            tok_account: {
              priority: 4, apiKey: 'account-secret', baseUrl: 'https://account.example.test', authProfile: 'sk-auth-profile',
              models: ['ghu_account_model'], capabilities: { transportProtocol: 'openai-chat-completions', streaming: false },
            },
          },
        },
      },
      server: { host: 'tok_server_host', port: 8181 },
      runtime: { continuous_improvement: true, process_timeouts: { planner_ms: 11, executor_ms: 12, reviewer_ms: 13 } },
      compaction: {
        enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2,
        merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4,
        escalate_summary_line_fraction: 0.6, snap: 'compact_straddler',
        summarizer_candidate: { provider: 'tok_provider', account: 'tok_account', model: 'sk-model' },
      },
      card_processes: cardProcesses,
      mcpServers: {
        tok_stdio_server: {
          transport: 'stdio', command: 'tok_command', args: ['sk-argument'],
          env: { HARMLESS_NAME: 'first-secret', tok_identity_key: 'second-secret' }, disabled: true, autostart: false,
        },
        sk_http_server: {
          transport: 'streamable-http', url: 'https://tok-host.example.test/mcp?api_key=structural-config-value', disabled: false, autostart: true,
        },
      },
    });

    const projected = redactForOutbound({ source: 'config', value: config });
    const expected = structuredClone(config);
    expected.providers.tok_provider!.apiKey = SECRET_REDACTION_PLACEHOLDER;
    expected.providers.tok_provider!.accounts!.tok_account!.apiKey = SECRET_REDACTION_PLACEHOLDER;
    const stdio = expected.mcpServers!.tok_stdio_server!;
    if (stdio.transport !== 'stdio') throw new Error('Expected stdio fixture.');
    stdio.env = { HARMLESS_NAME: SECRET_REDACTION_PLACEHOLDER, tok_identity_key: SECRET_REDACTION_PLACEHOLDER };

    expect(projected).toEqual(expected);
    expect(projected).not.toBe(config);
    expect(projected.models.profiles!.tok_primary).not.toBe(config.models.profiles!.tok_primary);
    expect(projected.providers.tok_provider!.accounts!.tok_account).not.toBe(config.providers.tok_provider!.accounts!.tok_account);
    expect(projected.card_processes.planning).not.toBe(config.card_processes.planning);
    expect((projected.mcpServers!.sk_http_server as { url: string }).url).toBe('https://tok-host.example.test/mcp?api_key=structural-config-value');
    expect(JSON.stringify(projected)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(JSON.stringify(projected)).not.toContain('account-secret');
    expect(JSON.stringify(projected)).not.toContain('first-secret');
    expect(JSON.stringify(projected)).not.toContain('second-secret');
  });
});
