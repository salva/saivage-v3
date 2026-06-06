# F34: Contracts Module Contains Misplaced Runtime Logic

**Severity:** LOW  
**Transversality:** LOCAL  
**Category:** Misplaced concerns  
**Verdict:** PARTLY SOUND — some files are legitimately contract-adjacent; others are runtime/prompt code

## Summary

The contracts module contains files that are not API contracts: `session-stamper.ts` (mutable runtime state), `candidate-availability.ts` (in-memory availability with persistence hooks), `system-prompt.ts` (prompt string templates), and `provider-candidate.ts` (provider routing data). These belong in their respective domain modules.

## Corrected Evidence

- `src/contracts/session-stamper.ts:26-97` — Mutable `SessionStampCounter` with runtime state
- `src/contracts/candidate-availability.ts:36-92` — In-memory availability with `persist()` method
- `src/contracts/system-prompt.ts:43-202` — 200 lines of prompt string templates
- `src/contracts/provider-candidate.ts:1-24` — Provider routing data
- `src/contracts/llm-failure.ts:9-54` — Error taxonomy (legitimately cross-boundary)
- `src/contracts/persisted-tool-call.ts:37-110` — Wire-format parsing (legitimately cross-boundary)

Overstatement corrected: `persisted-tool-call.ts` defines a persisted wire format and `llm-failure.ts` is a cross-boundary error contract. These are legitimately contract-adjacent. The clear misplacements are `session-stamper.ts`, `candidate-availability.ts`, and `system-prompt.ts`.

## Clean Architecture Approach

Move `session-stamper.ts` to runtime, `candidate-availability.ts` to agents/provider, `system-prompt.ts` to agents/prompts, and `provider-candidate.ts` to agents/provider. Keep `contracts/` narrowly for external API, agent envelope, and cross-boundary type contracts.