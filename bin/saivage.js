#!/usr/bin/env node

/**
 * Saivage v3 CLI wrapper.
 *
 * This script is the bin entry-point registered in package.json.
 * It imports the compiled CLI module and invokes run(process.argv) explicitly
 * so the launch path does not depend on cli.ts's self-bootstrap guard
 * (which only fires when the script is executed directly, not when
 * imported from a wrapper).
 */

import('../dist/src/cli.js').then((mod) => mod.run(process.argv)).catch((err) => {
  console.error(`Fatal error: ${err?.message ?? String(err)}`);
  process.exit(1);
});
