# F07 - Combined r2 Review

## Findings

No architectural blockers. r2 closes the r1 source-of-truth gap by making top-level `failover` invalid, deleting router consumption of the root shim, moving analyst writes under `models.failover`, and adding tests plus a one-off live config cleanup. The proposed `models.default` + sparse override shape matches the existing resolver and the zero-backward-compat policy.

## Advisory

- During implementation, update the analyst reconfigure schema/parser surfaces as part of the `setFailoverOrder` -> `setFailoverChain` rename, not just direct writer call sites. The plan states the user-facing argument changes to `forModel`; keep that reflected in the tool schema, input validation, and dispatch path so the analyst cannot still send a role-shaped failover request.

VERDICT: APPROVED