#!/usr/bin/env node

/**
 * Saivage v3 CLI wrapper.
 *
 * This script is the bin entry-point registered in package.json.
 * It imports the compiled CLI module, which self-bootstraps by calling
 * run(process.argv) at the top level.
 */

import('../dist/src/cli.js').catch((err) => {
  console.error(`Fatal error: ${err?.message ?? String(err)}`);
  process.exit(1);
});
