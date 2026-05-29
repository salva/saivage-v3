# F07 — Fallback chain duplication and the missing "tier" abstraction

## Summary

The fallback chain in `.saivage/saivage.json` is expressed by repeating model identifiers on every role and using a flat `models.failover` map keyed by full `provider/model` strings. There is no central declaration of "tier A primary", "tier B failover" — every role redeclares the chain. The router supports the layout but the operator brief reports that real-life configs end up duplicating the same `nvidia-nim/...` and `opencode-go/...` entries across roles, and an audit cannot say whether a given fallback list is intentional or stale.

NOTE — lack of evidence: the local repo's `.saivage/saivage.json` is the harness self-config (single `gpt-5.5` per role, narrow `failover` on `critic` only) and does NOT reproduce the operator-reported duplication. Confirming the duplication requires reading the live container config at `saivage-v3:/work/saivage-v3/.saivage/saivage.json`, which I have not done.

## Evidence

Schema (open record, no tier concept):
- [src/agents/config-schema.ts#L60-L92](src/agents/config-schema.ts#L60) — `modelsSectionSchema` is a passthrough record with reserved keys `temperature`, `max_tokens`, `profiles`, `routing`, `equivalents`, `failover`; every other key is treated as a role name with a list of model strings. Nothing prevents two roles from carrying the same list verbatim.

Router:
- [src/agents/model-router.ts#L51-L100](src/agents/model-router.ts#L51) — `resolve(role)` reads `getModelListForRole(role)`, walks each entry through `models.equivalents` and `models.failover`, dedupes by `seenModels`. Per-role; no shared chain.

Helpers consume only the per-role list:
- [src/agents/config-schema.ts#L100-L160](src/agents/config-schema.ts#L100) — `getModelListForRole`, `getModelParamsForRole`.

Local-only config (insufficient for confirmation):
- [.saivage/saivage.json](.saivage/saivage.json) shows e.g. `"reviewer": ["openai-codex/gpt-5.4"]` with no role-level failover, and the only `models.failover` entry is `"nvidia-nim/moonshotai/kimi-k2.6": ["opencode-go/kimi-k2.6", "openai-codex/gpt-5.4"]`. No duplication is visible here.

## Category

architectural / config ergonomics — evidence pending.

## Severity

medium (suspected); cannot be confirmed at the local repo. Re-grade after auditing the container config.

## Transversality

scoped to `config-schema.ts` and `.saivage/saivage.json`; router behaviour does not need to change to introduce tiers.

## Recommended direction

- Add an optional `models.tiers` section, e.g. `{ primary: [...], failover: [...], rescue: [...] }`. Allow a role's value to be a string referencing a tier name (`"planner": "primary+failover"`) in addition to an explicit list.
- Resolver computes the per-role list by expanding tier references, then applying equivalents and `failover`. This keeps the existing flat list as the lowest-level primitive and lets operators write one chain and refer to it from many roles.
- Add a `saivage doctor` check that flags a duplicated explicit list across roles, suggesting a tier extraction.

## Cross-links

- F03 — chain length matters less when cooldowns honour `Retry-After`; a deeper chain compensates for under-tuned cooldowns today.
- F08 — accurate classification reduces how much chain depth is needed.
