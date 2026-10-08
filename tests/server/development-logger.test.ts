import { describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type LoggerReport = {
  prettyWorker: boolean;
  routedStatus: number;
  routed: { url: string; query: Record<string, string>; authorization: string };
  malformedStatus: number;
  thrownStatus: number;
};

function runFixture<T>(mode: string): Promise<{ stdout: Buffer; stderr: Buffer; report: T }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      join(process.cwd(), 'tests/fixtures/development-logger.ts'), mode,
    ], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let report: T | undefined;
    // Both streams are present: the fixed spawn stdio above explicitly pipes them.
    child.stdout!.on('data', (bytes: Buffer) => stdout.push(bytes));
    child.stderr!.on('data', (bytes: Buffer) => stderr.push(bytes));
    child.on('message', (value) => { report = value as T; });
    // Killing is a failing runaway deadline, never normal worker lifecycle.
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Logger fixture ${mode} did not close normally within 15 seconds`));
    }, 15_000);
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      if (code !== 0 || signal !== null) {
        reject(new Error(`Logger fixture ${mode} failed (${code}, ${signal}): ${Buffer.concat(stderr).toString('utf8')}`));
      } else if (report === undefined) {
        reject(new Error(`Logger fixture ${mode} returned no report`));
      } else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), report });
    });
  });
}

function expectRequestSemantics(report: LoggerReport): void {
  expect(report).toMatchObject({ routedStatus: 200, malformedStatus: 400, thrownStatus: 500 });
  expect(report.routed).toEqual({
    url: '/logger-probe?ticket=LOGGER-QUERY-CREDENTIAL&query_marker=present',
    query: { ticket: 'LOGGER-QUERY-CREDENTIAL', query_marker: 'present' },
    authorization: 'Bearer LOGGER-HEADER-CREDENTIAL',
  });
}

function expectSourceSafety(output: string): void {
  expect(output).toContain('[REDACTED]');
  expect(output).toContain('safe prose');
  expect(output).toContain('more safe prose');
  for (const marker of ['LOGGER-SYNTHETIC-SECRET', 'LOGGER-QUERY-CREDENTIAL', 'LOGGER-HEADER-CREDENTIAL', 'query_marker']) {
    expect(output).not.toContain(marker);
  }
}

function region(output: string, field: string): string {
  const begin = `LOGGER-${field}-BEGIN`;
  const end = `LOGGER-${field}-END`;
  expect(output.split(begin)).toHaveLength(2);
  expect(output.split(end)).toHaveLength(2);
  const start = output.indexOf(begin);
  const finish = output.indexOf(end);
  expect(finish).toBeGreaterThan(start);
  return output.slice(start, finish + end.length);
}

// Remove only the known built-in formatter SGR, never injected clear-screen/OSC.
const formatterSgr = /\u001b\[(?:0|1|22|31|32|34|35|36|39|90)m/g;
const strippedControls = '[2J]0;INJECTED-TITLE';
const controls = '\u0000\u0007\r\u001b[2J\u001b]0;INJECTED-TITLE\u0007\u007f\u0085\u009b';

describe('real server console logger', () => {
  it.each([
    ['MESSAGE', `LOGGER-MESSAGE-BEGIN ordinary\ttext\nsecond-line ${strippedControls} LOGGER-MESSAGE-END`],
    ['KEY', `LOGGER-KEY-BEGIN property-${strippedControls} LOGGER-KEY-END`],
    // Ten renderer spaces plus the frame's original four spaces, with TAB intact.
    ['STACK', `LOGGER-STACK-BEGIN synthetic-error ${strippedControls}\n              at synthetic-frame\tLOGGER-STACK-END`],
  ])('strips controls at the default %s boundary while retaining colors, TAB and LF', async (field, expected) => {
    const { stdout, stderr, report } = await runFixture<LoggerReport>('development');
    expect(stderr.toString('utf8')).toBe('');
    expect(report.prettyWorker).toBe(true);
    expectRequestSemantics(report);
    const raw = stdout.toString('utf8');
    expect(raw).toContain('\u001b[32m');
    const visible = raw.replace(formatterSgr, '');
    // Complete field-local equality, without generic whitespace normalization
    // or a blanket control assertion over nested metadata / all stdout.
    expect(region(visible, field)).toBe(expected);
    expect(visible).toContain('LOGGER-KEY-END: "property-value"');
    expect(visible).toContain('safe prose token=[REDACTED]\nmore safe prose');
    expectSourceSafety(visible);
  }, 20_000);

  it('records 13.2.0 limitation evidence: stringified err.message retains literal DEL/C1 and JSON-escaped C0 (not a permanent product requirement)', async () => {
    const { stdout, stderr } = await runFixture<LoggerReport>('development');
    expect(stderr.toString('utf8')).toBe('');
    const visible = stdout.toString('utf8').replace(formatterSgr, '');
    const escapedControls = '\\u0000\\u0007\\r\\u001b[2J\\u001b]0;INJECTED-TITLE\\u0007\u007f\u0085\u009b';
    expect(region(visible, 'ERR-MESSAGE')).toBe(`LOGGER-ERR-MESSAGE-BEGIN synthetic-error ${escapedControls} LOGGER-ERR-MESSAGE-END`);
  }, 20_000);

  it('keeps production JSON output, source redaction and original routed request/error semantics without a pretty worker', async () => {
    const { stdout, stderr, report } = await runFixture<LoggerReport>('production');
    expect(stderr.toString('utf8')).toBe('');
    expect(report.prettyWorker).toBe(false);
    expectRequestSemantics(report);
    const raw = stdout.toString('utf8');
    expect(raw).not.toContain('\u001b');
    expect(raw.endsWith('\n')).toBe(true);
    const entries = raw.trimEnd().split('\n').map((line) => JSON.parse(line));
    // JSON preserves the original data; it has not acquired pretty sanitizing.
    expect(entries[0].msg).toBe(`LOGGER-MESSAGE-BEGIN ordinary\ttext\nsecond-line ${controls} LOGGER-MESSAGE-END`);
    expect(entries[0][`LOGGER-KEY-BEGIN property-${controls} LOGGER-KEY-END`]).toBe('property-value');
    expect(entries[0].err.message).toBe(`LOGGER-ERR-MESSAGE-BEGIN synthetic-error ${controls} LOGGER-ERR-MESSAGE-END`);
    expect(entries[0].err.stack).toBe(`Error: LOGGER-STACK-BEGIN synthetic-error ${controls}\n    at synthetic-frame\tLOGGER-STACK-END`);
    expect(entries[1].msg).toBe('safe prose token=[REDACTED]\nmore safe prose');
    const incoming = entries.filter((entry) => entry.msg === 'incoming request');
    expect(incoming.map((entry) => entry.req.url)).toEqual(['/logger-probe', '/logger-json', '/logger-error']);
    expect(incoming[0].req).toMatchObject({ method: 'GET', host: 'operator.example' });
    expectSourceSafety(raw);
  }, 20_000);

  it('pins the pretty dependency closure and rejects excessive copy depth deliberately in an isolated consumer smoke', async () => {
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/pino-pretty'].version).toBe('13.2.0');
    expect(lock.packages['node_modules/pino'].version).toBe('10.3.1');
    expect(lock.packages['node_modules/sonic-boom'].version).toBe('4.2.1');
    const { stdout, stderr, report } = await runFixture<{
      version: string; cloned: object; independent: boolean;
      prettyVersion: string; pinoVersion: string; prettySonicVersion: string; pinoSonicVersion: string;
      depthError: { name: string; message: string; rangeError: boolean };
    }>('copy');
    expect(stdout.length).toBe(0);
    expect(stderr.toString('utf8')).toBe('');
    expect(report.version).toBe('4.1.0');
    expect(report).toMatchObject({
      prettyVersion: '13.2.0', pinoVersion: '10.3.1', prettySonicVersion: '5.0.0', pinoSonicVersion: '4.2.1',
    });
    expect(report.cloned).toEqual({ nested: { value: 'shallow-copy' } });
    expect(report.independent).toBe(true);
    expect(report.depthError).toMatchObject({ name: 'MaxDepthExceededError', rangeError: true });
    expect(report.depthError.message).toContain('Maximum copy depth');
  }, 20_000);
});
