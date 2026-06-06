# F15: Operator API Contracts Have Repetitive Route Boilerplate

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Duplication  
**Verdict:** PARTLY SOUND — boilerplate is real but line count was overstated

## Summary

Operator API contract files repeat the same route definition pattern (operationId, method, path, success schema, error schema, response status map, successSchemaName) for ~30 routes. Each route also has complex permissions types mixing sync and async return values.

## Corrected Evidence

- `src/contracts/operator-api-runtime-cards.ts:135-244` — Typical route contract
- `src/contracts/operator-api-core.ts:39-54` — Complex permissions type
- Multiple `operator-api-*.ts` files with repeated route objects

Overstatement corrected: the total contract file size is approximately 900 lines, not ~1500. "8 files" is wrong — there are 10 operator-api files. Current routes do not appear to use the `permissions` field extensively.

## Clean Architecture Approach

Add a small route factory or table-driven helper that derives common response maps, auth requirements, and schema-name metadata from a compact route description `{ id, method, path, success, params?, query?, body? }`. Do not generate a heavier abstraction layer than the duplication it replaces.