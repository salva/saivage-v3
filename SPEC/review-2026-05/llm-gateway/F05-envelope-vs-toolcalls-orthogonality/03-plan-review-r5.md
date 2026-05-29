# F05 plan r5 review

## Blocking finding

1. B6's live-probe playbook cannot execute as written because the planned probe source is under `scripts/`, but root TypeScript does not emit `scripts/**/*.ts`. The plan creates `scripts/probe-llm-contract.ts` ([03-plan-r5.md](03-plan-r5.md#L445)) and then runs `node /opt/saivage-v3/dist/scripts/probe-llm-contract.js` from the container ([03-plan-r5.md](03-plan-r5.md#L484)), while [tsconfig.json](../../../../tsconfig.json#L17) includes only `src/**/*.ts` and `tests/**/*.ts`, and [package.json](../../../../package.json#L71) builds with plain `tsc` before deploy. That means `dist/scripts/probe-llm-contract.js` will not exist after `npm run build` / `rsync dist/`, so the final validation batch cannot complete. Fix the plan by either adding an explicit compile/copy path for the probe artifact, moving the probe into an emitted source tree, or changing the playbook to run a supported checked-in script on the container.

## Notes

The r4 runner blocker is fixed: r5 uses Jest-compatible root focused commands and Vitest only for the web project. No other blocker found against the approved Proposal L design.

VERDICT: CHANGES_REQUESTED