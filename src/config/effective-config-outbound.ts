import {
  effectiveSaivageConfigSchema,
  type ProviderCapabilities,
  type SaivageConfig,
} from '../schemas/saivage-config.js';
import { SECRET_REDACTION_PLACEHOLDER } from '../redaction/text.js';

type CardProcess = SaivageConfig['card_processes']['planning'];

export function projectEffectiveConfigForOutbound(value: SaivageConfig): SaivageConfig {
  const config = effectiveSaivageConfigSchema.parse(value);
  const projected: SaivageConfig = {
    models: {
      ...(config.models.analyst ? { analyst: [...config.models.analyst] } : {}),
      ...(config.models.planner ? { planner: [...config.models.planner] } : {}),
      ...(config.models.executor ? { executor: [...config.models.executor] } : {}),
      ...(config.models.reviewer ? { reviewer: [...config.models.reviewer] } : {}),
      ...(config.models.temperature ? { temperature: { ...config.models.temperature } } : {}),
      ...(config.models.max_tokens ? { max_tokens: { ...config.models.max_tokens } } : {}),
      ...(config.models.profiles ? { profiles: mapRecord(config.models.profiles, (profile) => ({ preferred: [...profile.preferred], allowed: [...profile.allowed] })) } : {}),
      ...(config.models.routing ? { routing: { ...config.models.routing } } : {}),
      ...(config.models.equivalents ? { equivalents: config.models.equivalents.map((group) => [...group]) } : {}),
      ...(config.models.failover ? { failover: mapRecord(config.models.failover, (models) => [...models]) } : {}),
      ...(config.models.default ? { default: [...config.models.default] } : {}),
    },
    providers: mapRecord(config.providers, (provider) => ({
      ...(provider.priority !== undefined ? { priority: provider.priority } : {}),
      ...(provider.models ? { models: [...provider.models] } : {}),
      ...(provider.apiKey !== undefined ? { apiKey: SECRET_REDACTION_PLACEHOLDER } : {}),
      ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.authProfile !== undefined ? { authProfile: provider.authProfile } : {}),
      ...(provider.capabilities ? { capabilities: projectCapabilities(provider.capabilities) } : {}),
      ...(provider.modelCapabilities ? { modelCapabilities: mapRecord(provider.modelCapabilities, projectCapabilities) } : {}),
      ...(provider.accounts ? { accounts: mapRecord(provider.accounts, (account) => ({
        ...(account.priority !== undefined ? { priority: account.priority } : {}),
        ...(account.apiKey !== undefined ? { apiKey: SECRET_REDACTION_PLACEHOLDER } : {}),
        ...(account.baseUrl !== undefined ? { baseUrl: account.baseUrl } : {}),
        ...(account.authProfile !== undefined ? { authProfile: account.authProfile } : {}),
        ...(account.models ? { models: [...account.models] } : {}),
        ...(account.capabilities ? { capabilities: projectCapabilities(account.capabilities) } : {}),
      })) } : {}),
    })),
    server: { port: config.server.port, host: config.server.host },
    runtime: {
      continuousImprovement: config.runtime.continuousImprovement,
      processTimeouts: {
        plannerMs: config.runtime.processTimeouts.plannerMs,
        executorMs: config.runtime.processTimeouts.executorMs,
        reviewerMs: config.runtime.processTimeouts.reviewerMs,
      },
    },
    compaction: {
      enabled: config.compaction.enabled,
      input_budget_tokens: config.compaction.input_budget_tokens,
      trigger_fraction: config.compaction.trigger_fraction,
      completion_reserve_fraction: config.compaction.completion_reserve_fraction,
      merge_line_fraction: config.compaction.merge_line_fraction,
      summary_line_fraction: config.compaction.summary_line_fraction,
      escalate_merge_line_fraction: config.compaction.escalate_merge_line_fraction,
      escalate_summary_line_fraction: config.compaction.escalate_summary_line_fraction,
      snap: config.compaction.snap,
      summarizer_candidate: {
        provider: config.compaction.summarizer_candidate.provider,
        account: config.compaction.summarizer_candidate.account,
        model: config.compaction.summarizer_candidate.model,
      },
    },
    card_processes: {
      planning: projectCardProcess(config.card_processes.planning),
      terminal: projectCardProcess(config.card_processes.terminal),
    },
    ...(config.mcpServers ? { mcpServers: mapRecord(config.mcpServers, (server) => {
      switch (server.transport) {
        case 'stdio': return {
          transport: server.transport,
          command: server.command,
          ...(server.args ? { args: [...server.args] } : {}),
          ...(server.env ? { env: mapRecord(server.env, () => SECRET_REDACTION_PLACEHOLDER) } : {}),
          disabled: server.disabled,
          autostart: server.autostart,
        };
        case 'streamable-http': return {
          transport: server.transport,
          url: server.url,
          disabled: server.disabled,
          autostart: server.autostart,
        };
      }
    }) } : {}),
  };
  return effectiveSaivageConfigSchema.parse(projected);
}

function projectCapabilities(value: ProviderCapabilities): ProviderCapabilities {
  return {
    ...(value.transportProtocol !== undefined ? { transportProtocol: value.transportProtocol } : {}),
    ...(value.toolsMode !== undefined ? { toolsMode: value.toolsMode } : {}),
    ...(value.exclusiveToolChoiceSupport !== undefined ? { exclusiveToolChoiceSupport: value.exclusiveToolChoiceSupport } : {}),
    ...(value.streaming !== undefined ? { streaming: value.streaming } : {}),
    ...(value.responsesReasoning ? { responsesReasoning: { ...value.responsesReasoning } } : {}),
    ...(value.contextWindowTokens !== undefined ? { contextWindowTokens: value.contextWindowTokens } : {}),
    ...(value.maxOutputTokens !== undefined ? { maxOutputTokens: value.maxOutputTokens } : {}),
    ...(value.quirks ? { quirks: [...value.quirks] } : {}),
  };
}

function projectCardProcess(process: CardProcess): CardProcess {
  return {
    entries: {
      BACKLOG: { node: process.entries.BACKLOG.node, ...(process.entries.BACKLOG.prompt !== undefined ? { prompt: process.entries.BACKLOG.prompt } : {}) },
      CHANGED: { node: process.entries.CHANGED.node, ...(process.entries.CHANGED.prompt !== undefined ? { prompt: process.entries.CHANGED.prompt } : {}) },
      BLOCKED: { node: process.entries.BLOCKED.node, ...(process.entries.BLOCKED.prompt !== undefined ? { prompt: process.entries.BLOCKED.prompt } : {}) },
      STOPPED: { node: process.entries.STOPPED.node, prompt: process.entries.STOPPED.prompt },
    },
    nodes: mapRecord(process.nodes, (node) => ({
      role: node.role,
      prompt: node.prompt,
      correction_prompt: node.correction_prompt,
      records: node.records.map((record) => ({ name: record.name, updated: record.updated })),
      edges: mapRecord(node.edges, (edge) => ({
        target: 'node' in edge.target ? { node: edge.target.node } : { terminal: edge.target.terminal },
        ...(edge.prompt !== undefined ? { prompt: edge.prompt } : {}),
      })),
    })),
  };
}

function mapRecord<Input, Output>(record: Readonly<Record<string, Input>>, project: (value: Input) => Output): Record<string, Output> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, project(value)]));
}
