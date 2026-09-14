import { createAppTerminalCoordinator, createOversightOwnerFailureHandler, startApp } from '../../src/boot/app.js';
import { ProjectOversight } from '../../src/application/project-oversight.js';

const scenario = process.argv[2];
const projectRoot = process.argv[3];

if (scenario === 'coordinator-fast-reject') {
  const terminal = createAppTerminalCoordinator();
  terminal.registerCleanupLeaf('runtime', () => Promise.reject(new Error('private failure')));
  const started = performance.now();
  const report = await terminal.stop();
  const elapsed = performance.now() - started;
  const settledAt = performance.now();
  process.once('beforeExit', () => {
    process.stdout.write(`${JSON.stringify({ elapsed, exitReadyElapsed: performance.now() - settledAt, report })}\n`);
  });
} else if (scenario === 'coordinator-hang') {
  const terminal = createAppTerminalCoordinator();
  let later = false;
  terminal.registerCleanupLeaf('fastify', () => { later = true; });
  terminal.registerCleanupLeaf('runtime', () => new Promise<void>(() => undefined));
  const started = Date.now();
  const report = await terminal.stop();
  process.stdout.write(`${JSON.stringify({ elapsed: Date.now() - started, later, report })}\n`);
} else if (scenario === 'oversight-owner-failure') {
  const terminal = createAppTerminalCoordinator();
  terminal.registerAdmissionCloser('runtime', () => process.stdout.write('ADMISSION_CLOSED\n'));
  terminal.registerAdmissionCloser('oversight', () => process.stdout.write('OVERSIGHT_CLOSED\n'));
  terminal.registerCleanupLeaf('runtime', () => { process.stdout.write('RUNTIME_CLEANED\n'); });
  terminal.registerCleanupLeaf('oversight', async () => { process.stdout.write('OVERSIGHT_SETTLED\n'); });
  const fail = createOversightOwnerFailureHandler({
    terminal,
    exit: (code) => process.exit(code),
    writeDiagnostic: () => process.stderr.write('[oversight] owner failure; application terminating\n'),
  });
  const oversight = new ProjectOversight({
    enabled: true,
    intervalMs: 1,
    agentName: 'oversight',
    sessionId: 'agent:oversight:global',
    serviceEpoch: new Date().toISOString(),
    changed() {},
    onOwnerFailure: fail,
    createCheck() {
      return {
        run: async () => { throw new Error('private-provider-and-state-details'); },
        cancel() {}, assertEffectSignal() {}, executingLlmSnapshot: () => null,
      } as never;
    },
  });
  terminal.registerAdmissionCloser('oversight', () => oversight.closeAdmission());
  terminal.registerCleanupLeaf('oversight', () => oversight.cleanupForApplicationStop());
  oversight.runtimeStatusChanged('running');
} else {
  if (!projectRoot) throw new Error('Child-process App scenario requires a project root.');
  try {
    const app = await startApp({ projectRoot, createRuntime: false, env: process.env });
    if (scenario === 'signal') {
      process.stdout.write('READY\n');
    } else if (scenario === 'restart-75') {
      const address = app.server.fastify.server.address();
      if (address === null || typeof address === 'string') throw new Error('Restart fixture has no TCP address.');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime/restart-server`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env['SAIVAGE_API_TOKEN']}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: 'RESTART SERVER' }),
      });
      process.stdout.write(`RESTART_RESPONSE:${response.status}:${await response.text()}\n`);
    } else {
      throw new Error(`Unknown App child scenario '${scenario}'.`);
    }
  } catch (error) {
    process.stderr.write(`STARTUP_ERROR:${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(23);
  }
}
