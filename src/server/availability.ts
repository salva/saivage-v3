import type { McpStatusProvider } from '../mcp/index.js';
import type { ActiveRuntime } from '../runtime/index.js';
import { readRuntimeState } from '../runtime/index.js';
import { redactOperatorErrorMessage } from '../workspace/index.js';
import { redactSnippetForOutbound } from '../redaction/index.js';
import type { ServerAvailability } from '../contracts/index.js';

type StartupFailure = {
  code: string;
  error: unknown;
};

export interface ServerAvailabilityInputs {
  projectRoot: string;
  activeRuntime?: () => ActiveRuntime | undefined;
  mcpManager?: () => McpStatusProvider | undefined;
  runtimeStartupFailure?: () => StartupFailure | undefined;
  mcpStartupFailure?: () => StartupFailure | undefined;
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
  const activeRuntime = inputs.activeRuntime?.();
  const mcpManager = inputs.mcpManager?.();
  const runtimeFailure = inputs.runtimeStartupFailure?.();
  const mcpFailure = inputs.mcpStartupFailure?.();

  const api = {
    state: 'available' as const,
    source: 'health-check' as const,
    checkedAt,
  };

  let runtime: ServerAvailability['components']['runtime'];
  if (activeRuntime) {
    runtime = { state: 'available', source: 'active-runtime', checkedAt };
  } else if (runtimeFailure) {
    runtime = {
      state: 'unavailable',
      source: 'startup',
      checkedAt,
      diagnostic: diagnostic(runtimeFailure.code, runtimeFailure.error, inputs.projectRoot),
    };
  } else {
    try {
      const state = readRuntimeState(inputs.projectRoot);
      runtime = state
        ? { state: 'degraded', source: 'runtime-state', checkedAt }
        : { state: 'unknown', source: 'unknown', checkedAt };
    } catch (error) {
      runtime = {
        state: 'unknown',
        source: 'runtime-state',
        checkedAt,
        diagnostic: diagnostic('runtime-state-read-failed', error, inputs.projectRoot),
      };
    }
  }

  let mcp: ServerAvailability['components']['mcp'];
  if (mcpManager) {
    try {
      const statuses = mcpManager.getStatus();
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
  } else if (mcpFailure) {
    mcp = {
      state: 'unavailable',
      source: 'startup',
      checkedAt,
      diagnostic: diagnostic(mcpFailure.code, mcpFailure.error, inputs.projectRoot),
    };
  } else {
    mcp = { state: 'unknown', source: 'unknown', checkedAt };
  }

  return {
    generatedAt,
    components: { api, runtime, mcp },
  };
}
