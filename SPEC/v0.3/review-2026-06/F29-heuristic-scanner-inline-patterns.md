# F29: Heuristic Scanner Is 573 Lines of Inline Regex Patterns

**Severity:** LOW  
**Transversality:** LOCAL  
**Category:** Bad data representation  
**Verdict:** PARTLY SOUND — maintainability is real; testability claim is overstated

## Summary

`heuristic-scanner.ts` defines a 573-line `PATTERN_DEFS` array inline. The `compile()` function can throw at module load time, meaning a bad pattern definition crashes the process on import.

## Corrected Evidence

- `src/workspace/heuristic-scanner.ts:89-662` — 573-line inline pattern array
- `src/workspace/heuristic-scanner.ts:666-687` — `compile()` at module load time

Overstatement corrected: `PATTERNS_BY_CATEGORY` is exported at line 697-699, so patterns can be tested independently. The compile-time failure is testable. The maintainability concern and import-time crash risk remain real.

## Clean Architecture Approach

Move pattern definitions to a dedicated data module or data file. Compile through an explicit factory function called at startup, not at import time. Validate patterns in a dedicated test. Keep scanner logic small and focused.