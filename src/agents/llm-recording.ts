import type { Candidate } from '../contracts/provider-candidate.js';
import type { LlmExchangeRecorder } from './llm-exchange-recorder.js';
import { LlmRequestError } from './llm-errors.js';

const STREAM_TEE_MAX_BYTES = 16 * 1024 * 1024;

export function teeStreamForRecorder(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  getBuffer: () => string;
} {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buf = '';
  let truncated = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!truncated) {
            const text = decoder.decode(value, { stream: true });
            if (buf.length + text.length > STREAM_TEE_MAX_BYTES) {
              const remaining = Math.max(0, STREAM_TEE_MAX_BYTES - buf.length);
              buf += text.slice(0, remaining) + '\n[truncated at 16 MiB]\n';
              truncated = true;
            } else {
              buf += text;
            }
          }
          controller.enqueue(value);
        }
        if (!truncated) buf += decoder.decode();
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        try { reader.releaseLock(); } catch { /* noop */ }
      }
    },
  });

  return { stream, getBuffer: () => buf };
}

export interface LlmRecorderRequest {
  transport: 'generic' | 'codex';
  contract_id: string;
  contractName: string;
  candidate: Candidate;
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  terminalToolOffered: readonly string[];
}

export async function beginRecordedExchange(
  recorder: LlmExchangeRecorder | undefined,
  request: LlmRecorderRequest,
) {
  if (!recorder) return undefined;
  return recorder.beginExchange({
    transport: request.transport,
    contract_id: request.contract_id,
    contractName: request.contractName,
    candidate: {
      provider: request.candidate.provider,
      model: request.candidate.model,
      account: request.candidate.account ?? undefined,
    },
    request: { endpoint: request.endpoint, method: 'POST', headers: request.headers, body: request.body },
    terminalToolOffered: request.terminalToolOffered,
  });
}

export async function recordResponseError(
  handle: Awaited<ReturnType<LlmExchangeRecorder['beginExchange']>> | undefined,
  err: unknown,
  bodyRaw: string | null,
): Promise<void> {
  if (!handle) return;
  const e = err as Error;
  const status = err instanceof LlmRequestError && 'status' in err.failure
    ? (err.failure as { status?: number }).status
    : undefined;
  await handle.recordError({
    errorName: e.name ?? 'Error',
    message: e.message ?? String(err),
    status,
    bodyRaw,
  });
}
