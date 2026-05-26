# t2 Domain / Architecture / Quality Baseline Research

Access date: 2026-05-26.

## Outputs

Primary baseline artifacts were written to:

- `architecture-audit/baseline/domain-model.md`
- `architecture-audit/baseline/architecture-map.md`
- `architecture-audit/baseline/quality-report.md`
- `architecture-audit/baseline/risk-register.md`

## Method

Read current on-disk source only under `/work/saivage-v3`, excluding historical/forbidden areas by mission rule. Used local line-number extraction logs under `architecture-audit/baseline/tmp-*.log` for evidence. No source/product/test files were modified.

## Key findings

- Runtime, agent adapter, MCP manager, card store, and server composition are the main architectural hotspots.
- Runtime and agents have a bidirectional conceptual dependency: runtime imports agent implementation surfaces while `AgentAdapter` imports runtime state.
- Backend schemas/contracts and web API types duplicate many domain types, creating drift risk.
- API routing has mixed contract-backed, inline, and ad hoc route styles.
- Existing import-boundary tooling is useful but package-root imports and type-only server/runtime links still allow architectural leaks.
