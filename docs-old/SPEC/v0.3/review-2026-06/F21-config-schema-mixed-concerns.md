# F21: Config Schema File Mixes Schema, Loading, Migration, and Runtime Defaults

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Multi-purpose abstraction  
**Verdict:** SOUND — confirmed at `src/agents/config-schema.ts`

## Summary

`src/agents/config-schema.ts` (449 lines) mixes config schema definition, config loading, legacy migration, model parameter resolution, and runtime defaults all in one file.

## Corrected Evidence

- `src/agents/config-schema.ts:5-72` — Legacy migration/normalization logic
- `src/agents/config-schema.ts:186-215` — Runtime defaults hardcoded in schema transform
- `src/agents/config-schema.ts:328-347` — `getModelParamsForRole` runtime accessor
- `src/agents/config-schema.ts:412-441` — `getModelListForRole` runtime accessor

## Clean Architecture Approach

Split into: `config/schema.ts` (pure Zod schemas), `config/load.ts` (file reading and parsing), `config/migrations.ts` (legacy transforms), and `config/selectors.ts` (model params/role resolution). Keep persisted schema defaults separate from runtime-only operational defaults.