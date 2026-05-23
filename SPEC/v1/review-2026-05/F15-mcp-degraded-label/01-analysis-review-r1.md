# F15 — Reviewer Critique (round 1)

Reviewed:

- [00-issue.md](00-issue.md)
- [01-analysis-r1.md](01-analysis-r1.md)
- [02-design-r1.md](02-design-r1.md)
- [03-plan-r1.md](03-plan-r1.md)

## Finding

1. **Plan validation uses the wrong root test runner.** The analysis and design are sound, but the implementation plan's server validation commands use `npx vitest run tests/server/server-availability-contract.test.ts tests/server/operator-api-contracts.test.ts` and `npx vitest run`. The root project is configured for Jest: [package.json](../../../../package.json) defines `test` as `NODE_OPTIONS=--experimental-vm-modules jest`, while Vitest is only a web dependency in [web/package.json](../../../../web/package.json). This makes the plan's root server test commands unrealistic and conflicts with the validation skill's Jest guidance. Required change: replace the root server test commands with the project-standard Jest form, e.g. `NODE_OPTIONS=--experimental-vm-modules npx jest tests/server/server-availability-contract.test.ts tests/server/operator-api-contracts.test.ts --runInBand --forceExit` for focused coverage and `npm test -- --runInBand --forceExit` for the full server sweep. Also make the deployment validation explicitly include the host `npm run build` before the SSH restart, matching the Saivage validation skill.

## Approved Portions

- The cited owner code matches current implementation: [src/server/availability.ts](../../../../src/server/availability.ts) emits `degraded` for the empty MCP-manager branch, and [src/contracts/operator-api.ts](../../../../src/contracts/operator-api.ts) currently restricts `AvailabilityStateSchema` to the four existing values.
- Adding `idle` is justified as a new operator-facing state, not a backward-compatibility alias. It cleanly separates "intentionally inactive because no MCP servers are configured" from "configured but impaired."
- The design preserves F22's binding decision: misconfiguration should fail fast elsewhere, while an intentionally empty MCP server list remains valid and should not depend on degraded-mode signalling.
- The web mirror, dashboard store, server tests, operator contract fixture, and docs are the right update surface. The plan correctly avoids `src/mcp/*`, runtime internals, and build artifacts.
- Deployment direction is otherwise correct: host-side build, SSH restart of `saivage-v3-getrich.service` on `10.0.3.170`, health probes, and no rsync.

## Notes For Round 2

- Do not copy the illustrative enum comments from the design snippet into untouched production code; the file-level implementation plan already avoids new comments, which is the right discipline.
- Keep `diagnostic.code: 'mcp-manager-empty'` while changing the summary to `No MCP servers configured.` as proposed.

VERDICT: CHANGES_REQUESTED
