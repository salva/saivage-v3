import { redactForOutbound } from '../redaction/index.js';
import { writeLatestLlmExchange } from './llm-exchange-log.js';
import type {
  ExchangeAttempt,
  ExchangeErrorMeta,
  ExchangeRequestMeta,
  ExchangeResponseMeta,
  LlmExchange,
  TerminalToolName,
} from '../contracts/index.js';

/**
 * Narrow logger interface used by the recorder for failure-isolation events.
 * Kept independent from `EventLogger` so the recorder doesn't need a registered
 * event kind for its diagnostics, and so tests can supply a simple stub.
 */
export interface LlmExchangeRecorderLogger {
  recordExchangeRecorderError(event: {
    source: 'llm-exchange-recorder';
    level: 'warn' | 'error';
    sessionId: string;
    attempt?: number;
    message: string;
    cause?: unknown;
  }): void;
}

export interface ExchangeHandle {
  recordResponse(meta: ExchangeResponseMeta): Promise<void>;
  recordError(meta: ExchangeErrorMeta): Promise<void>;
}

export interface BeginExchangeInput {
  transport: 'generic' | 'codex';
  contract_id: string;
  candidate: { provider: string; model: string; account?: string };
  request: ExchangeRequestMeta;
  terminalTool: TerminalToolName | null;
}

export interface LlmExchangeRecorder {
  beginExchange(meta: BeginExchangeInput): Promise<ExchangeHandle>;
  flush(): Promise<void>;
}

export interface CreateLlmExchangeRecorderOptions {
  saivageDir: string;
  sessionId: string;
  eventLogger?: LlmExchangeRecorderLogger;
}

type WriteFn = (saivageDir: string, exchange: LlmExchange) => Promise<void>;

/** For tests only: allow injecting a custom write function. */
export interface InternalLlmExchangeRecorderOptions extends CreateLlmExchangeRecorderOptions {
  _writeExchange?: WriteFn;
}

export function createLlmExchangeRecorder(
  opts: InternalLlmExchangeRecorderOptions,
): LlmExchangeRecorder {
  const { saivageDir, sessionId, eventLogger } = opts;
  const write: WriteFn = opts._writeExchange ?? writeLatestLlmExchange;

  let current: LlmExchange | null = null;
  let lock: Promise<void> = Promise.resolve();

  function enqueueWrite(snapshotFn: () => LlmExchange, attemptIndex: number): Promise<void> {
    const next = lock.then(async () => {
      try {
        const snapshot = snapshotFn();
        await write(saivageDir, snapshot);
      } catch (err) {
        const e = err as Error;
        try {
          eventLogger?.recordExchangeRecorderError({
            source: 'llm-exchange-recorder',
            level: 'warn',
            sessionId,
            attempt: attemptIndex,
            message: e.message,
            cause: err,
          });
        } catch {
          // never let logger failures escape
        }
      }
    });
    lock = next;
    return next;
  }

  async function beginExchange(meta: BeginExchangeInput): Promise<ExchangeHandle> {
    const attemptIndex = current?.attempts.length ?? 0;
    const startedAt = new Date().toISOString();

    const redactedRequest = redactForOutbound(meta.request, 'operator.api', {
      source: 'llm-client.exchange-capture',
    }) as ExchangeRequestMeta;

    const attempt: ExchangeAttempt = {
      attempt: attemptIndex,
      startedAt,
      status: 'in-progress',
      request: redactedRequest,
      terminalTool: meta.terminalTool,
    };

    if (current === null) {
      current = {
        sessionId,
        contract_id: meta.contract_id,
        capturedAt: startedAt,
        transport: meta.transport,
        candidate: { ...meta.candidate },
        attempts: [attempt],
      };
    } else {
      current = {
        ...current,
        contract_id: meta.contract_id,
        transport: meta.transport,
        candidate: { ...meta.candidate },
        attempts: [...current.attempts, attempt],
      };
    }

    await enqueueWrite(() => snapshotCurrent(), attemptIndex);

    const handle: ExchangeHandle = {
      async recordResponse(responseMeta: ExchangeResponseMeta): Promise<void> {
        const completedAt = new Date().toISOString();
        const redacted = redactForOutbound(responseMeta, 'operator.api', {
          source: 'llm-client.exchange-capture',
        }) as ExchangeResponseMeta;
        if (current) {
          current = {
            ...current,
            attempts: current.attempts.map((a) =>
              a.attempt === attemptIndex
                ? { ...a, status: 'ok', completedAt, response: redacted, error: undefined }
                : a,
            ),
          };
        }
        await enqueueWrite(() => snapshotCurrent(), attemptIndex);
      },
      async recordError(errorMeta: ExchangeErrorMeta): Promise<void> {
        const completedAt = new Date().toISOString();
        const redacted = redactForOutbound(errorMeta, 'operator.api', {
          source: 'llm-client.exchange-capture',
        }) as ExchangeErrorMeta;
        if (current) {
          current = {
            ...current,
            attempts: current.attempts.map((a) =>
              a.attempt === attemptIndex
                ? { ...a, status: 'error', completedAt, error: redacted, response: undefined }
                : a,
            ),
          };
        }
        await enqueueWrite(() => snapshotCurrent(), attemptIndex);
      },
    };
    return handle;
  }

  function snapshotCurrent(): LlmExchange {
    if (!current) throw new Error('llm-exchange-recorder: snapshot requested with no current exchange');
    return {
      ...current,
      candidate: { ...current.candidate },
      attempts: current.attempts.map((a) => ({ ...a })),
    };
  }

  async function flush(): Promise<void> {
    await lock;
  }

  return { beginExchange, flush };
}

/**
 * Build a `LlmExchangeRecorderLogger` that emits recorder diagnostics via
 * `console.warn`. The recorder's diagnostic event has no matching `EventKind`
 * in the project's `EventLogger`, so failures are surfaced as benign warnings.
 *
 * Accepts an unused `EventLogger`-shaped argument for future extension; today
 * the implementation ignores it and writes to stderr.
 */
export function toRecorderLogger(_eventLogger?: unknown): LlmExchangeRecorderLogger {
  return {
    recordExchangeRecorderError(event): void {
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[llm-exchange-recorder] session=${event.sessionId} attempt=${event.attempt ?? '-'} ${event.message}`,
        );
      } catch {
        // Never let logger failures escape.
      }
    },
  };
}
