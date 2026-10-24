import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { inventoryWorkGarbage, collectWorkGarbage } from '../../src/workspace/work-garbage-collector.js';
import { createApplicationFatalPort } from '../../src/contracts/publication-outcome.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { createEventLog } from '../../src/observability/index.js';
import { workGcOperatorApiContracts } from '../../src/contracts/operator-api-work-gc.js';
import { buildWorkGcOperatorContractHandlers } from '../../src/server/routes/operator-work-gc-handlers.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';

const [root, mode] = process.argv.slice(2);
if (!root || !['unlink', 'fsync'].includes(mode!)) throw new Error('Expected synthetic root and fault mode');
initProjectTree(root);
const marker = join(root, 'marker');
const mark = (text: string) => fs.appendFileSync(marker, `${text}\n`);
const candidate = join(root, '.saivage/work/cards/project/tmp/disposable');
fs.mkdirSync(dirname(candidate), { recursive: true }); fs.writeFileSync(candidate, 'scratch');
const fatal = createApplicationFatalPort();
const server = Fastify({ logger: false });
server.addHook('onSend', async () => { mark('response'); });
server.addHook('onError', async () => { mark('http-error'); });
const unlink = fs.unlinkSync, fsync = fs.fsyncSync, close = fs.closeSync;
let deleting = false;
fs.unlinkSync = path => {
  if (path === candidate) {
    mark('unlink'); deleting = true;
    if (mode === 'unlink') throw new Error('GC unlink uncertain');
  }
  return unlink(path);
};
fs.fsyncSync = fd => {
  if (deleting) { mark('fsync'); throw new Error('GC directory fsync uncertain'); }
  return fsync(fd);
};
fs.closeSync = fd => { if (deleting) mark('descriptor-close'); return close(fd); };
syncBuiltinESMExports();
const application = {
  async collectWorkGarbage(_request: unknown, signal: AbortSignal) {
    const inventory = await inventoryWorkGarbage(root, signal);
    try {
      await collectWorkGarbage(inventory, { mode: 'delete' }, {
        workflows: TEST_WORKFLOWS, operationalInputs: {},
        protection: { retainAll: false, capturePaths: [] }, assertCollecting() {},
        fatal: error => fatal.publicationOutcomeUnknown(error),
      });
      mark('report');
    } finally { mark('admission-release'); }
    throw new Error('Fatal returned');
  },
} as unknown as RuntimeApplication;
new ContractRuntime({ authPolicy: new AuthPolicy({}),
  eventLogger: createEventLog(root), fatalPort: fatal }).mount(server,
  workGcOperatorApiContracts, buildWorkGcOperatorContractHandlers(application));
const origin = await server.listen({ host: '127.0.0.1', port: 0 });
mark('request');
await fetch(`${origin}/api/runtime/gc-work`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'delete' }) });
mark('client-response');
await server.close();
