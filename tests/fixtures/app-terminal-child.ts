import { createAppTerminalCoordinator, startApp } from '../../src/boot/app.js';

const scenario = process.argv[2];
const projectRoot = process.argv[3];

if (scenario === 'coordinator-fast-reject') {
  const terminal = createAppTerminalCoordinator();
  terminal.registerCleanupLeaf('runtime', () => Promise.reject(new Error('private failure')));
  const started = Date.now();
  const report = await terminal.stop();
  process.stdout.write(`${JSON.stringify({ elapsed: Date.now() - started, report })}\n`);
} else if (scenario === 'coordinator-hang') {
  const terminal = createAppTerminalCoordinator();
  let later = false;
  terminal.registerCleanupLeaf('fastify', () => { later = true; });
  terminal.registerCleanupLeaf('runtime', () => new Promise<void>(() => undefined));
  const started = Date.now();
  const report = await terminal.stop();
  process.stdout.write(`${JSON.stringify({ elapsed: Date.now() - started, later, report })}\n`);
} else {
  if (!projectRoot) throw new Error('Child-process App scenario requires a project root.');
  try {
    const app = await startApp({ argv: ['node', 'child', 'start', '--project-root', projectRoot], env: process.env });
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
