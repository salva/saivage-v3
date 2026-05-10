/**
 * Minimal logger for the web UI.
 *
 * Wraps console methods with a prefix and optional level filtering.
 * Used by the WebSocket manager and other non-Vue utilities.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LOG_LEVEL as string) || 'info'
) as LogLevel;

const minPriority = LEVEL_PRIORITY[currentLevel];

export function createLogger(prefix: string): Logger {
  const shouldLog = (level: LogLevel): boolean => {
    return LEVEL_PRIORITY[level] >= minPriority;
  };

  return {
    debug: (...args: unknown[]) => {
      if (shouldLog('debug')) console.debug(`[${prefix}]`, ...args);
    },
    info: (...args: unknown[]) => {
      if (shouldLog('info')) console.info(`[${prefix}]`, ...args);
    },
    warn: (...args: unknown[]) => {
      if (shouldLog('warn')) console.warn(`[${prefix}]`, ...args);
    },
    error: (...args: unknown[]) => {
      if (shouldLog('error')) console.error(`[${prefix}]`, ...args);
    },
  };
}
