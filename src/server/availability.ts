import type { McpStatusProvider } from '../mcp/manager-api.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { redactOperatorErrorMessage } from '../workspace/index.js';
import { redactSnippetForOutbound } from '../redaction/index.js';
import type { ServerAvailability } from '../contracts/index.js';
import type { ApplicationPersistenceHealthSnapshot } from '../application/persistence-health.js';

export interface ServerAvailabilityInputs {
  projectRoot: string;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpStatusProvider;
}

function nowIso(): string {
  return new Date().toISOString();
}

function boundedSummary(error: unknown, projectRoot: string): string {
  const name = error instanceof Error ? error.name : 'Error';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const redacted = boundedValue(rawMessage, projectRoot, 180);
  const summary = `${name}: ${redacted}`.replace(/\s+/g, ' ').trim();
  return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary;
}

function boundedValue(value: string, projectRoot: string, limit = 240): string {
  return redactSnippetForOutbound(redactOperatorErrorMessage(value, projectRoot), 'operator.api', limit, { source: 'availability.diagnostic' }).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function diagnostic(code: string, error: unknown, projectRoot: string) {
  return {
    code,
    summary: boundedSummary(error, projectRoot),
  };
}

export function buildServerAvailability(inputs: ServerAvailabilityInputs): ServerAvailability {
  const generatedAt = nowIso();
  const checkedAt = generatedAt;

  const api = {
    state: 'available' as const,
    source: 'health-check' as const,
    checkedAt,
  };

  let runtime: ServerAvailability['components']['runtime'];
  try {
    inputs.runtimeApplication.runtimeApi.getStatus();
    runtime = { state: 'available', source: 'runtime-application', checkedAt };
  } catch (error) {
    runtime = {
      state: 'degraded',
      source: 'runtime-application',
      checkedAt,
      diagnostic: diagnostic('runtime-status-read-failed', error, inputs.projectRoot),
    };
  }

  let mcp: ServerAvailability['components']['mcp'];
  try {
    const statuses = inputs.mcpManager.getStatus();
    const hasRunning = statuses.some((status) => status.status === 'running');
    const hasConfigured = statuses.length > 0;
    mcp = hasRunning
      ? { state: 'available', source: 'mcp-manager', checkedAt }
      : hasConfigured
        ? { state: 'degraded', source: 'mcp-manager', checkedAt }
        : {
            state: 'idle',
            source: 'mcp-manager',
            checkedAt,
            diagnostic: { code: 'mcp-manager-empty', summary: 'No MCP servers configured.' },
          };
  } catch (error) {
    mcp = {
      state: 'unknown',
      source: 'mcp-manager',
      checkedAt,
      diagnostic: diagnostic('mcp-status-read-failed', error, inputs.projectRoot),
    };
  }

  const persistenceSnapshot = projectPersistenceHealthSnapshot(inputs.runtimeApplication.persistenceHealth.snapshot(), inputs.projectRoot);
  const persistence: ServerAvailability['components']['persistence'] = persistenceSnapshot.state === 'healthy'
    ? { state: 'available', source: 'runtime-application', checkedAt }
    : {
        state: 'unavailable',
        source: 'runtime-application',
        checkedAt,
        diagnostic: {
          code: 'persistence-mutation-unhealthy',
          summary: `${persistenceSnapshot.diagnostic.operation} on ${persistenceSnapshot.diagnostic.target}: ${persistenceSnapshot.diagnostic.message}`.slice(0, 240),
        },
      };

  return {
    generatedAt,
    components: { api, runtime, mcp, persistence },
  };
}

export function projectPersistenceHealthSnapshot(snapshot: ApplicationPersistenceHealthSnapshot, projectRoot: string) {
  if (snapshot.state === 'healthy') return snapshot;
  return {
    state: snapshot.state,
    diagnostic: {
      target: boundedValue(snapshot.diagnostic.target, projectRoot),
      operation: snapshot.diagnostic.operation.slice(0, 240),
      message: boundedValue(snapshot.diagnostic.message, projectRoot),
      reported_at: snapshot.diagnostic.reported_at,
    },
  } as const;
}
