#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAnalystServer, type AnalystServerOptions } from './analyst.js';
import { startRuntime, type ActiveRuntime } from '../utils/active-runtime.js';

function parseArgs(argv: string[]): AnalystServerOptions & { runtimeHandle?: ActiveRuntime } {
  let projectRoot = process.cwd();
  let sessionId: string | undefined;
  let runtimeHandle: ActiveRuntime | undefined;

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) break;
    if (arg === '--project-root') {
      const value = args.shift();
      if (!value) throw new Error('--project-root requires a value');
      projectRoot = value;
      continue;
    }
    if (arg === '--session-id') {
      const value = args.shift();
      if (!value) throw new Error('--session-id requires a value');
      sessionId = value;
      continue;
    }
    if (arg === '--with-runtime') {
      runtimeHandle = startRuntime({ projectRoot });
      continue;
    }
  }

  return { projectRoot, sessionId, runtimeHandle };
}

async function main(): Promise<void> {
  const { runtimeHandle, ...options } = parseArgs(process.argv.slice(2));
  const server = createAnalystServer({
    ...options,
    activeRuntime: runtimeHandle,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
