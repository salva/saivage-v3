import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ErrorLogger, type ErrorRecord, type ErrorInput } from '../../src/observability/error-logger.js';

describe('ErrorLogger', () => {
  let tmpDir: string;
  let saivageDir: string;
  let errorLogger: ErrorLogger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-el-'));
    saivageDir = join(tmpDir, '.saivage');
    mkdirSync(join(saivageDir, 'logs'), { recursive: true });
    errorLogger = new ErrorLogger(saivageDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a record to errors.jsonl with correct fields', () => {
    const input: ErrorInput = {
      message: 'Something went wrong',
      cardId: 'card-1',
      goalId: 'goal-1',
      phase: 'executor',
    };

    const record = errorLogger.appendError(input);

    expect(record.id).toBeTruthy();
    expect(record.id.startsWith('err-')).toBe(true);
    expect(record.kind).toBe('error');
    expect(record.timestamp).toBeTruthy();
    expect(record.message).toBe('Something went wrong');
    expect(record.cardId).toBe('card-1');
    expect(record.goalId).toBe('goal-1');
    expect(record.phase).toBe('executor');

    const logPath = errorLogger.getErrorsPath();
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);

    const envelope = JSON.parse(lines[0]) as { type: string; data: ErrorRecord };
    expect(envelope.type).toBe('error');
    const parsed = envelope.data;
    expect(parsed.id).toBe(record.id);
    expect(parsed.kind).toBe('error');
    expect(parsed.timestamp).toBe(record.timestamp);
    expect(parsed.message).toBe('Something went wrong');
    expect(parsed.cardId).toBe('card-1');
    expect(parsed.goalId).toBe('goal-1');
    expect(parsed.phase).toBe('executor');
  });

  it('getErrors() reads back written records', () => {
    errorLogger.appendError({ message: 'Error 1', cardId: 'c1' });
    errorLogger.appendError({ message: 'Error 2', cardId: 'c2' });

    const errors = errorLogger.getErrors();
    expect(errors.length).toBe(2);
    expect(errors[0].message).toBe('Error 1');
    expect(errors[0].cardId).toBe('c1');
    expect(errors[1].message).toBe('Error 2');
    expect(errors[1].cardId).toBe('c2');
  });

  it('getErrorsPath() returns the correct path', () => {
    const path = errorLogger.getErrorsPath();
    expect(path).toBe(join(saivageDir, 'logs', 'app.jsonl'));
  });

  it('filter by cardId works', () => {
    errorLogger.appendError({ message: 'Error for c1', cardId: 'card-a' });
    errorLogger.appendError({ message: 'Error for c2', cardId: 'card-b' });
    errorLogger.appendError({ message: 'More c1', cardId: 'card-a' });

    const filtered = errorLogger.getErrors({ cardId: 'card-a' });
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.cardId === 'card-a')).toBe(true);

    const filteredB = errorLogger.getErrors({ cardId: 'card-b' });
    expect(filteredB.length).toBe(1);
    expect(filteredB[0].message).toBe('Error for c2');
  });

  it('filter by goalId works', () => {
    errorLogger.appendError({ message: 'Goal 1 error', goalId: 'goal-1' });
    errorLogger.appendError({ message: 'Goal 2 error', goalId: 'goal-2' });
    errorLogger.appendError({ message: 'Another goal 1', goalId: 'goal-1' });

    const filtered = errorLogger.getErrors({ goalId: 'goal-1' });
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.goalId === 'goal-1')).toBe(true);
  });

  it('filter by phase works', () => {
    errorLogger.appendError({ message: 'Planner error', phase: 'planner' });
    errorLogger.appendError({ message: 'Executor error', phase: 'executor' });
    errorLogger.appendError({ message: 'Reviewer error', phase: 'reviewer' });

    const filtered = errorLogger.getErrors({ phase: 'executor' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].message).toBe('Executor error');
  });

  it('filter by since works', () => {
    const baseTime = new Date('2025-01-01T00:00:00Z').toISOString();

    errorLogger.appendError({
      message: 'Old error',
      timestamp: baseTime,
      cardId: 'old',
    });
    errorLogger.appendError({
      message: 'New error',
      cardId: 'new',
    });

    const since = new Date('2025-06-01T00:00:00Z').toISOString();
    const filtered = errorLogger.getErrors({ since });
    expect(filtered.length).toBe(1);
    expect(filtered[0].message).toBe('New error');
  });

  it('filter by limit works', () => {
    for (let i = 0; i < 10; i++) {
      errorLogger.appendError({ message: `Error ${i}` });
    }

    const limited = errorLogger.getErrors({ limit: 3 });
    expect(limited.length).toBe(3);
    expect(limited[0].message).toBe('Error 7');
    expect(limited[1].message).toBe('Error 8');
    expect(limited[2].message).toBe('Error 9');
  });

  it('filter with limit=0 returns all records', () => {
    errorLogger.appendError({ message: 'Error A' });
    errorLogger.appendError({ message: 'Error B' });

    const all = errorLogger.getErrors({ limit: 0 });
    expect(all.length).toBe(2);
  });

  it('multiple appendError calls persist all records', () => {
    for (let i = 0; i < 50; i++) {
      errorLogger.appendError({ message: `Error ${i}`, cardId: `card-${i % 5}` });
    }

    const errors = errorLogger.getErrors();
    expect(errors.length).toBe(50);

    const messages = new Set(errors.map((e) => e.message));
    for (let i = 0; i < 50; i++) {
      expect(messages.has(`Error ${i}`)).toBe(true);
    }
  });

  it('empty file returns empty array', () => {
    const errors = errorLogger.getErrors();
    expect(errors).toEqual([]);
  });

  it('persists appended records synchronously', () => {
    errorLogger.appendError({ message: 'Test' });

    const errors = errorLogger.getErrors();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('Test');
  });

  it('auto-generated timestamp is valid ISO string', () => {
    const record = errorLogger.appendError({ message: 'Test timestamp' });
    const parsed = Date.parse(record.timestamp);
    expect(isNaN(parsed)).toBe(false);

    const tsMs = new Date(record.timestamp).getTime();
    const nowMs = Date.now();
    expect(nowMs - tsMs).toBeLessThan(5000);
  });

  it('preserves extra fields on the error record', () => {
    errorLogger.appendError({
      message: 'Custom error',
      cardId: 'c1',
      customField: 'extra-value',
      nested: { foo: 'bar' },
    });

    const errors = errorLogger.getErrors();
    expect(errors[0].customField).toBe('extra-value');
    expect(errors[0].nested).toEqual({ foo: 'bar' });
  });

  it('generates unique error IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const record = errorLogger.appendError({ message: `Error ${i}` });
      ids.add(record.id);
    }
    expect(ids.size).toBe(100);
  });

  it('skips malformed lines in the file', () => {
    errorLogger.appendError({ message: 'Valid error' });

    const logPath = errorLogger.getErrorsPath();
    const existing = readFileSync(logPath, 'utf-8');
    writeFileSync(logPath, existing + 'NOT VALID JSON\n');

    const errors = errorLogger.getErrors();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('Valid error');
  });

  it('filter combinations AND together', () => {
    errorLogger.appendError({ message: 'A', cardId: 'c1', goalId: 'g1', phase: 'planner' });
    errorLogger.appendError({ message: 'B', cardId: 'c1', goalId: 'g1', phase: 'executor' });
    errorLogger.appendError({ message: 'C', cardId: 'c2', goalId: 'g1', phase: 'planner' });
    errorLogger.appendError({ message: 'D', cardId: 'c1', goalId: 'g2', phase: 'planner' });

    const filtered = errorLogger.getErrors({
      cardId: 'c1',
      goalId: 'g1',
    });
    expect(filtered.length).toBe(2);
    expect(filtered.map((e) => e.message).sort()).toEqual(['A', 'B']);
  });

  it('filter with limit and other criteria', () => {
    for (let i = 0; i < 5; i++) {
      errorLogger.appendError({ message: `E${i}`, cardId: 'cX' });
    }
    for (let i = 0; i < 5; i++) {
      errorLogger.appendError({ message: `E${i + 5}`, cardId: 'cY' });
    }

    const filtered = errorLogger.getErrors({ cardId: 'cX', limit: 3 });
    expect(filtered.length).toBe(3);
    expect(filtered.map((e) => e.message)).toEqual(['E2', 'E3', 'E4']);
  });

  it('writes appended records to disk immediately', () => {
    errorLogger.appendError({ message: 'Buffered' });

    const logPath = errorLogger.getErrorsPath();
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('Buffered');
  });
});

describe('ErrorLogger — JSONL Format Compatibility', () => {
  let tmpDir: string;
  let saivageDir: string;
  let errorLogger: ErrorLogger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-el-fmt-'));
    saivageDir = join(tmpDir, '.saivage');
    mkdirSync(join(saivageDir, 'logs'), { recursive: true });
    errorLogger = new ErrorLogger(saivageDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('every line in errors.jsonl is valid JSON with kind=error, timestamp, message', () => {
    errorLogger.appendError({
      message: 'First test error',
      cardId: 'card-fmt-1',
      goalId: 'goal-fmt-1',
      phase: 'planner',
    });
    errorLogger.appendError({
      message: 'Second test error',
      cardId: 'card-fmt-2',
      phase: 'executor',
    });
    errorLogger.appendError({
      message: 'Minimal error',
    });

    const logPath = errorLogger.getErrorsPath();
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines.length).toBe(3);

    for (const line of lines) {
      let parsed: { id: string; timestamp: string; type: string; data: ErrorRecord };
      expect(() => {
        parsed = JSON.parse(line) as { id: string; timestamp: string; type: string; data: ErrorRecord };
      }).not.toThrow();

      parsed = JSON.parse(line) as { id: string; timestamp: string; type: string; data: ErrorRecord };
      expect(parsed.type).toBe('error');
      expect(parsed.data.kind).toBe('error');
      expect(parsed.timestamp).toBeTruthy();
      expect(typeof parsed.timestamp).toBe('string');
      const tsMs = Date.parse(parsed.timestamp);
      expect(isNaN(tsMs)).toBe(false);
      expect(parsed.data.message).toBeTruthy();
      expect(typeof parsed.data.message).toBe('string');
      expect(parsed.id).toBeTruthy();
      expect(typeof parsed.id).toBe('string');
    }
  });

  it('file format matches what GET /api/debug/errors expects', () => {
    errorLogger.appendError({
      message: 'API test error',
      cardId: 'api-card',
      goalId: 'api-goal',
      phase: 'reviewer',
    });

    const errorsPath = join(saivageDir, 'logs', 'app.jsonl');
    const raw = readFileSync(errorsPath, 'utf-8');
    const errors: unknown[] = [];

    for (const line of raw.split('\n').filter(Boolean)) {
      errors.push((JSON.parse(line) as { data: unknown }).data);
    }

    expect(errors.length).toBe(1);
    const record = errors[0] as ErrorRecord;
    expect(record.kind).toBe('error');
    expect(record.message).toBe('API test error');
    expect(record.cardId).toBe('api-card');
    expect(record.goalId).toBe('api-goal');
    expect(record.phase).toBe('reviewer');
  });

  it('getErrors handles file-not-found gracefully (endpoint-compatible)', () => {
    const errors = errorLogger.getErrors();
    expect(errors).toEqual([]);
  });

  it('no trailing characters after records, each line is self-contained', () => {
    errorLogger.appendError({ message: 'Line 1' });
    errorLogger.appendError({ message: 'Line 2' });

    const content = readFileSync(errorLogger.getErrorsPath(), 'utf-8');
    const lines = content.split('\n');
    const nonEmptyLines = lines.filter((l) => l.trim() !== '');
    expect(nonEmptyLines.length).toBe(2);

    for (const line of nonEmptyLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
