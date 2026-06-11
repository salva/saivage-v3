import type { McpStatusProvider } from '../mcp/manager-api.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { readRuntimeState } from '../runtime/state-api.js';
import { redactOperatorErrorMessage } from '../workspace/index.js';
import { redactSnippetForOutbound } from '../redaction/index.js';
import type { ServerAvailability } from '../contracts/index.js';

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
  const redacted = redactSnippetForOutbound(redactOperatorErrorMessage(rawMessage, projectRoot), 'operator.api', 180, { source: 'availability.diagnostic' });
  const summary = `${name}: ${redacted}`.replace(/\s+/g, ' ').trim();
  return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary;
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
    try {
      const state = readRuntimeState(inputs.projectRoot);
      runtime = state
        ? { state: 'available', source: 'runtime-state', checkedAt }
        : { state: 'degraded', source: 'runtime-state', checkedAt, diagnostic: { code: 'runtime-state-missing', summary: 'Runtime application is running but runtime state is not initialized.' } };
    } catch (stateError) {
      runtime = {
        state: 'degraded',
        source: 'runtime-state',
        checkedAt,
        diagnostic: diagnostic('runtime-state-read-failed', stateError, inputs.projectRoot),
      };
    }
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

  return {
    generatedAt,
    components: { api, runtime, mcp },
  };
}
