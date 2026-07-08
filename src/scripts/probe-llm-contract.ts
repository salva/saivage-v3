// F05 B6: Live contract-shape probe for each configured provider × role.
//
// Reads <projectRoot>/.saivage/saivage.yaml only. Does NOT read
// .saivage/auth-profiles.json — providers that need OAuth refresh will simply
// be reported as skipped (no_api_key) rather than implicitly authenticated.
//
// Emits one JSON line per (provider, role). Exits 0 only when every emitted
// row has status "ok"; any error or skip yields exit 1 (the operator inspects
// the rows to decide which findings warrant follow-up issues).

import type { SaivageConfig } from '../agents/config-schema.js';
import { loadEnvironment } from '../config/index.js';
import { resolveModelListForRole } from '../config/model-role-resolution.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import { ProviderRegistry, type Provider } from '../agents/provider.js';
import { LlmProviderGateway } from '../agents/llm-provider-gateway.js';
import { buildLlmOptions } from '../agents/llm-options-factory.js';
import { createPlannerContract } from '../contracts/planner-contract.js';
import { createExecutorContract } from '../contracts/executor-contract.js';
import { createReviewerContract } from '../contracts/reviewer-contract.js';
import { unwrapFailure } from '../agents/llm-errors.js';
import type { ToolDefinition } from '../agents/llm-contracts.js';
import type { OperationalAgentRole, AgentMessage } from '../schemas/index.js';

const ROLES: OperationalAgentRole[] = ['planner', 'executor', 'reviewer', 'analyst'];

const PING_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'ping',
    description: 'No-op tool used by the contract probe; do not invoke in production.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

interface ProbeRow {
  provider: string;
  role: OperationalAgentRole;
  model?: string;
  status: 'ok' | 'error' | 'skipped';
  ms: number;
  kind?: string;
  subtype?: string;
  bodyPreview?: string;
  error?: string;
  reason?: string;
}

function pickModelForRole(provider: Provider, roleModels: string[]): string | null {
  for (const model of roleModels) {
    if (provider.canServe(model)) return model;
  }
  return null;
}

function buildCandidate(provider: Provider, model: string): { candidate: Candidate; baseUrl?: string; apiKey?: string } {
  const candidates = provider.getCandidatesForModel(model);
  if (candidates.length === 0) {
    return { candidate: { provider: provider.name, account: null, model } };
  }
  const candidate = candidates[0];
  const account = candidate.account != null
    ? provider.getAllAccounts().find((a) => a.name === candidate.account) ?? provider.implicitAccount
    : provider.implicitAccount;
  return {
    candidate,
    baseUrl: account.baseUrl ?? provider.baseUrl,
    apiKey: account.apiKey ?? provider.apiKey,
  };
}

function buildOptionsForRole(role: OperationalAgentRole) {
  if (role === 'analyst') {
    return buildLlmOptions(role, [PING_TOOL], [], { temperature: 0, max_tokens: 64 }, undefined, undefined);
  }
  const contract =
    role === 'planner'
      ? createPlannerContract()
      : role === 'executor'
        ? createExecutorContract()
        : createReviewerContract();
  const tools = contract.terminals.map((t) => t.toolDefinition);
  const offered = contract.terminals.map((t) => t.name);
  return buildLlmOptions(role, tools, offered, { temperature: 0, max_tokens: 64 }, undefined, undefined);
}

function buildPingMessage(): AgentMessage {
  const now = new Date().toISOString();
  return {
    id: 'probe-msg-1',
    session_id: 'probe-session',
    role: 'user',
    kind: 'text',
    content: 'ping; respond with the terminal tool only',
    round_id: 'probe-round-1',
    message_index: 0,
    block_index: 0,
    timestamp: now,
  };
}

function emit(row: ProbeRow): void {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

async function probeOne(
  provider: Provider,
  role: OperationalAgentRole,
  config: SaivageConfig,
  registry: ProviderRegistry,
): Promise<ProbeRow> {
  const start = Date.now();
  const roleModels = resolveModelListForRole(config, role) ?? [];
  const model = pickModelForRole(provider, roleModels);
  if (!model) {
    return { provider: provider.name, role, status: 'skipped', ms: Date.now() - start, reason: 'no_supported_model' };
  }
  const { candidate, baseUrl, apiKey } = buildCandidate(provider, model);
  if (!baseUrl) {
    return { provider: provider.name, role, model, status: 'skipped', ms: Date.now() - start, reason: 'no_base_url' };
  }
  if (!apiKey) {
    return { provider: provider.name, role, model, status: 'skipped', ms: Date.now() - start, reason: 'no_api_key' };
  }
  const gateway = new LlmProviderGateway({ baseUrl, apiKey, registry });
  const opts = buildOptionsForRole(role);
  const messages = [buildPingMessage()];
  const systemPrompt = 'You are a contract probe. Respond by calling the terminal tool exactly once with minimal arguments.';
  try {
    await gateway.complete(candidate, systemPrompt, messages, 'probe-session', opts);
    return { provider: provider.name, role, model, status: 'ok', ms: Date.now() - start };
  } catch (err) {
    const failure = unwrapFailure(err);
    const bodyPreview = failure.kind === 'provider_protocol_error' ? failure.bodyPreview : undefined;
    return {
      provider: provider.name,
      role,
      model,
      status: 'error',
      ms: Date.now() - start,
      kind: failure.kind,
      subtype: undefined,
      error: failure.message,
      bodyPreview,
    };
  }
}

async function main(): Promise<number> {
  const projectRoot = process.argv[2] ?? process.cwd();
  const { config } = loadEnvironment(['node', 'probe-llm-contract', '--project-root', projectRoot], process.env);
  const registry = new ProviderRegistry(config);
  const providers = registry.getAll();
  let allOk = providers.length > 0;
  for (const provider of providers) {
    for (const role of ROLES) {
      const row = await probeOne(provider, role, config, registry);
      emit(row);
      if (row.status !== 'ok') allOk = false;
    }
  }
  return allOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${JSON.stringify({ status: 'fatal', error: err instanceof Error ? err.message : String(err) })}\n`);
    process.exit(2);
  },
);
