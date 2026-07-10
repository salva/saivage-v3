import type { ProviderExchangeAttempt, ProviderExchangeOkPayload } from '../contracts/provider-exchange.js';

export interface ProviderExchangeRecorderLogger {
  recordProviderExchangeRecorderError(event: {
    source: 'provider-exchange-recorder';
    level: 'warn' | 'error';
    sessionId: string;
    attempt?: number;
    message: string;
    cause?: unknown;
  }): void;
}

export interface ProviderExchangeHandle {
  recordResponse(meta: { status: number; token_usage?: ProviderExchangeOkPayload['token_usage']; finish_reason?: string | null }, terminalToolFired: string | null): Promise<void>;
  recordError(meta: { errorName: string; message: string; status?: number }): Promise<void>;
}

export interface BeginProviderExchangeInput {
  transport: 'generic' | 'codex' | 'openai-responses';
  contract_id: string;
  contractName: string;
  candidate: { provider: string; model: string; account?: string };
  requestParams: Record<string, unknown>;
  terminalToolOffered: readonly string[];
  sourceInputId: string;
}

export interface ProviderExchangeRecorder {
  beginExchange(meta: BeginProviderExchangeInput): Promise<ProviderExchangeHandle>;
  settledAttempts(): ProviderExchangeAttempt[];
  flush(): Promise<void>;
}

export interface CreateProviderExchangeRecorderOptions {
  sessionId: string;
  eventLogger?: ProviderExchangeRecorderLogger;
}

export function createProviderExchangeRecorder(_opts: CreateProviderExchangeRecorderOptions): ProviderExchangeRecorder {
  const attempts: ProviderExchangeAttempt[] = [];

  async function beginExchange(meta: BeginProviderExchangeInput): Promise<ProviderExchangeHandle> {
    const startedAt = new Date().toISOString();
    const base = {
      contract_id: meta.contract_id,
      contract_name: meta.contractName,
      transport: meta.transport,
      provider: meta.candidate.provider,
      model: meta.candidate.model,
      ...(meta.candidate.account ? { account: meta.candidate.account } : {}),
      source_input_id: meta.sourceInputId,
      request_params: {
        ...meta.requestParams,
        offered_tools_count: meta.terminalToolOffered.length,
      },
      started_at: startedAt,
      terminal_tool_fired: null,
    } as const;
    return {
      async recordResponse(responseMeta, terminalToolFired): Promise<void> {
        const completedAt = new Date().toISOString();
        attempts.push({
          ...base,
          completed_at: completedAt,
          status: 'ok',
          response_status: responseMeta.status,
          finish_reason: responseMeta.finish_reason,
          token_usage: responseMeta.token_usage,
          latency_ms: latencyMs(startedAt, completedAt),
          terminal_tool_fired: terminalToolFired,
        });
      },
      async recordError(errorMeta): Promise<void> {
        const completedAt = new Date().toISOString();
        attempts.push({
          ...base,
          completed_at: completedAt,
          status: 'error',
          response_status: errorMeta.status,
          latency_ms: latencyMs(startedAt, completedAt),
          terminal_tool_fired: null,
          error: { name: errorMeta.errorName, message: errorMeta.message, ...(errorMeta.status !== undefined ? { status: errorMeta.status } : {}) },
        });
      },
    };
  }

  return {
    beginExchange,
    settledAttempts: () => attempts.map((attempt) => ({ ...attempt })),
    async flush(): Promise<void> {},
  };
}

export function toProviderExchangeRecorderLogger(_eventLogger?: unknown): ProviderExchangeRecorderLogger {
  return {
    recordProviderExchangeRecorderError(event): void {
      try {
        console.warn(`[provider-exchange-recorder] session=${event.sessionId} attempt=${event.attempt ?? '-'} ${event.message}`);
      } catch {}
    },
  };
}

function latencyMs(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}
