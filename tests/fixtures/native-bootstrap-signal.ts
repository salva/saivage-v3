import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDirectMutationComposition } from '../../src/boot/direct-mutation-composition.js';
import { publishInitialProjectRuntime } from '../../src/boot/project-runtime-bootstrap.js';
import { compileProjectWorkflowDeclarations } from '../../src/runtime/card-process/card-process-config.js';
import { createApplicationFatalPort } from '../../src/contracts/index.js';
import { runtimeProcessLockFile } from '../../src/persistence/layout.js';

const root = process.argv[2]!;
const workflows = compileProjectWorkflowDeclarations(JSON.parse(readFileSync(join(root, '.saivage/bootstrap-fixture.json'), 'utf8')), { projectRoot: root });
let sent = false;
const observer = setInterval(() => {
  if (!sent && existsSync(join(root, '.saivage/pending'))) {
    if (!existsSync(runtimeProcessLockFile(root))) throw new Error('Initializer lost exclusion before hook signal.');
    sent = true;
    process.kill(process.pid, 'SIGTERM');
  }
}, 20);
try {
  await withDirectMutationComposition(root, 'init', createApplicationFatalPort(), async owner => {
    owner.createAndBindProjectIdentity();
    await publishInitialProjectRuntime(root, workflows, owner);
  });
  throw new Error('Cancelled bootstrap unexpectedly succeeded.');
} catch (error) {
  if (!sent || existsSync(runtimeProcessLockFile(root))) throw error;
  console.log('signal-settled-lock-released');
} finally {
  clearInterval(observer);
}
