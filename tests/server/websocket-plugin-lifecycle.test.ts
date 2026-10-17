import { expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const node = process.execPath;
const probe = fileURLToPath(new URL('./fixtures/websocket-plugin-probe.ts', import.meta.url));

// A broken upgrade error owner must not crash Jest. GNU timeout also bounds
// leaked handles: a probe succeeds only by exiting naturally, never forceExit.
it.each(['admission', 'established-error', 'tcp-reset', 'injected-upgrade-error'])(
  'actual application WebSocket composition: %s',
  async (scenario) => {
    const result = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('timeout', ['--signal=TERM', '--kill-after=5s', '35s', node, '--import', 'tsx', probe, scenario], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toContainEqual({ probeRuntime: { execPath: node, version: process.version } });
    console.info(JSON.stringify({ scenario, runtime: rows[0], code: result.code, signal: result.signal }));
    expect(result).toEqual({ code: 0, signal: null, stdout: expect.any(String), stderr: '' });
    expect(rows).toContainEqual({ completed: scenario });
    if (scenario === 'established-error') {
      expect(result.stdout).not.toContain('SYNTHETIC_BEARER_PRIVATE');
      expect(result.stdout).not.toContain('wst_');
      expect(result.stdout).not.toContain('?ticket=');
      // The default plugin handler must use the actual request child logger.
      expect(rows).toContainEqual(expect.objectContaining({
        level: 50, reqId: expect.any(String),
        err: expect.objectContaining({ code: 'WS_ERR_UNEXPECTED_RSV_2_3' }),
      }));
      expect(rows).toContainEqual(expect.objectContaining({ req: expect.objectContaining({ url: '/ws' }) }));
    }
  },
  45_000,
);
