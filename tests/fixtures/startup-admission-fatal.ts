import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const scenario = process.argv[2];
const projectRoot = process.argv[3]!;
const target = process.argv[4]!;
const descriptors = new Set<number>();
const open = fs.openSync;
const write = fs.writeSync;
const truncate = fs.ftruncateSync;
const read = fs.readFileSync;
const close = fs.closeSync;
const sync = fs.fsyncSync;
let faulted = false;
const forbidAfterFault = () => { if (faulted) process.stdout.write('FORBIDDEN_FOLLOWUP\n'); };
fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
  forbidAfterFault(); return read(...args);
}) as typeof fs.readFileSync;
fs.closeSync = (descriptor) => { forbidAfterFault(); close(descriptor); };
fs.fsyncSync = (descriptor) => {
  // The fatal port flushes its diagnostic stdio before immediate exit.
  if (descriptor !== 1 && descriptor !== 2) forbidAfterFault();
  sync(descriptor);
};
fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
  forbidAfterFault();
  const descriptor = open(...args);
  if (String(args[0]) === target) descriptors.add(descriptor);
  else descriptors.delete(descriptor);
  return descriptor;
}) as typeof fs.openSync;
if (scenario === 'startup-admission-mate') {
  fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
    // The fatal port's sole stderr diagnostic is not a persistence follow-up.
    if (args[0] !== 2) forbidAfterFault();
    const written = write(...args);
    if (descriptors.has(args[0])) {
      faulted = true;
      process.stdout.write('MATE_WRITE_UNCERTAIN\n');
      throw new Error('mate write uncertain');
    }
    return written;
  }) as typeof fs.writeSync;
} else {
  fs.ftruncateSync = (descriptor, length) => {
    forbidAfterFault();
    truncate(descriptor, length);
    if (descriptors.has(descriptor)) {
      faulted = true;
      process.stdout.write('TRUNCATE_UNCERTAIN\n');
      throw new Error('truncate uncertain');
    }
  };
}
syncBuiltinESMExports();

// Load syscall-owning modules only after fault injection, as in the other real-process fixtures.
const { startApp } = await import('../../src/boot/app.js');
const { CardService } = await import('../../src/cards/card-service.js');
const { McpManager } = await import('../../src/mcp/mcp-manager.js');
const { SyncHub } = await import('../../src/server/sync-hub.js');
CardService.prototype.stopRunning = function (): never { process.stdout.write('FORBIDDEN_STOP\n'); throw new Error('Unexpected card stop'); };
McpManager.prototype.reconcilePersistedConfig = async function (): Promise<never> { process.stdout.write('FORBIDDEN_MCP\n'); throw new Error('Unexpected MCP'); };
SyncHub.prototype.dispose = function (): void { process.stdout.write('FORBIDDEN_CLEANUP\n'); };
try {
  await startApp({ projectRoot, createRuntime: false, env: process.env });
  process.stdout.write('FORBIDDEN_READY\n');
} catch (error) {
  process.stderr.write(`STARTUP_ERROR:${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(23);
}
