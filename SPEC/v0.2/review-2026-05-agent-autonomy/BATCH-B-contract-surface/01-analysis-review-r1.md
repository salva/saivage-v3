# Batch B Analysis Review - r1

## Verdict Summary

The Batch B analysis is directionally strong: it correctly identifies the role-keyed envelope taxonomy, the prompt/runtime contract mismatch, and the deferred `activate_card` synthesis branch as one connected contract-surface problem. It is also self-contained and covers F05/F06/F07 at the right conceptual level.

Changes are still required before approval. The main problems are exactness of several cited source anchors, an unflagged compatibility fallback in deferred activation parsing, and an under-specified persistence/recording impact surface for `activate_card` and terminal-tool recording.

## Source Reference Verification

Verified references that are substantively correct:

- `ROLE_RESULT_TOOL_NAMES`, `buildToolDef`, and `ROLE_RESULT_TOOLS` are at [../../../src/agents/role-result-tools.ts#L4](../../../src/agents/role-result-tools.ts#L4), [../../../src/agents/role-result-tools.ts#L19](../../../src/agents/role-result-tools.ts#L19), and [../../../src/agents/role-result-tools.ts#L34](../../../src/agents/role-result-tools.ts#L34).
- `isEnvelopeBearing` and the terminal-role lookup in `buildLlmOptions` are at [../../../src/agents/llm-options-factory.ts#L15](../../../src/agents/llm-options-factory.ts#L15) and [../../../src/agents/llm-options-factory.ts#L49](../../../src/agents/llm-options-factory.ts#L49).
- `validateTerminalToolCall` is at [../../../src/agents/terminal-protocol.ts#L6](../../../src/agents/terminal-protocol.ts#L6), and it really reads both the expected terminal name and schema from global role maps.
- The adapter's role-derived terminal setup is at [../../../src/agents/agent-adapter.ts#L292-L295](../../../src/agents/agent-adapter.ts#L292-L295), and the deferred activation recognition is at [../../../src/agents/agent-adapter.ts#L352](../../../src/agents/agent-adapter.ts#L352).

Incorrect or stale anchors that must be fixed:

1. The analysis cites `EnvelopeBearingRole` at `role-envelope-schemas.ts#L62` and `ENVELOPE_SCHEMAS` at `#L64`. The current file has the type at [../../../src/agents/role-envelope-schemas.ts#L64](../../../src/agents/role-envelope-schemas.ts#L64) and the map at [../../../src/agents/role-envelope-schemas.ts#L66](../../../src/agents/role-envelope-schemas.ts#L66). The finding is correct, but the line anchors are not exact.
2. The prompt anchors are materially stale. The planner raw-JSON instruction is at [../../../src/agents/system-prompt.ts#L64-L65](../../../src/agents/system-prompt.ts#L64-L65), the executor raw-JSON instruction is at [../../../src/agents/system-prompt.ts#L129](../../../src/agents/system-prompt.ts#L129), and the reviewer raw-JSON instruction is at [../../../src/agents/system-prompt.ts#L218](../../../src/agents/system-prompt.ts#L218). The cited `#L139` and `#L209` do not identify the stated instructions.
3. Several deferred-synthesis anchors are close but imprecise: the branch starts at [../../../src/agents/agent-adapter.ts#L358](../../../src/agents/agent-adapter.ts#L358), the inline `CardStore` construction is at [../../../src/agents/agent-adapter.ts#L360](../../../src/agents/agent-adapter.ts#L360), and the final persisted JSON response is at [../../../src/agents/agent-adapter.ts#L388](../../../src/agents/agent-adapter.ts#L388). The analysis should update all anchors rather than relying on near misses.

## Findings

1. The analysis misses a direct backward-compatibility shim in deferred activation parsing.

   F06 is not only about adapter-side synthesis. The parser used by the adapter accepts a legacy payload shape and manufactures a `DeferredActivationEnvelopeV1` with `parent_card_id`, `planner_session_id`, and `tool_call_id` set to the literal string `legacy` at [../../../src/schemas/validators.ts#L68-L70](../../../src/schemas/validators.ts#L68-L70). Because [../../../src/agents/agent-adapter.ts#L352](../../../src/agents/agent-adapter.ts#L352) treats any parsed deferred envelope as the trigger for the synthesis path, this fallback is part of the live contract surface.

   Required change: the analysis must explicitly identify this as a backward-compatibility smell and state that the redesign should delete or replace it under the workspace rule of no migration shims and no old-format preservation. Keeping `DeferredActivationEnvelopeV1` as a current domain shape may be defensible, but accepting `__saivage_defer_tool_result` and filling fields with `legacy` is not.

2. The cross-cutting impact section undercounts message persistence for `activate_card`.

   The analysis correctly calls out the synthetic assistant `text` row at [../../../src/agents/agent-adapter.ts#L388](../../../src/agents/agent-adapter.ts#L388), but the persistence surface is broader. `findUniqueUnresolvedActivateCardToolCall` scans persisted assistant `tool_call` rows for unresolved `activate_card` calls at [../../../src/agents/session-persistence.ts#L405-L432](../../../src/agents/session-persistence.ts#L405-L432), and `appendActivateCardToolResultOnce` persists completion tool results at [../../../src/agents/session-persistence.ts#L446-L461](../../../src/agents/session-persistence.ts#L446-L461). The runtime also has a separate unresolved-activation scanner at [../../../src/runtime/runtime.ts#L239-L262](../../../src/runtime/runtime.ts#L239-L262).

   Required change: add these persistence consumers to the impact map. A redesign that changes whether `activate_card` is an ordinary tool, a terminal signal, or a contract-recognized deferred signal must specify how these scanners distinguish unresolved calls, completion envelopes, and contract terminal records.

3. Recording impact needs one more concrete consumer.

   The analysis identifies `TERMINAL_TOOL_NAMES` in `src/contracts/llm-exchange.ts`, which is correct, but it should also name the agent-side recorder code that consumes that closed enum. `deriveTerminalToolFromOptions` narrows terminal tool names through `TERMINAL_TOOL_NAMES` in [../../../src/agents/llm-recording.ts#L58-L67](../../../src/agents/llm-recording.ts#L58-L67). If the terminal contract becomes per-invocation, this is not merely a schema change; the recorder's terminal-name derivation needs to read from the contract value or accept contract metadata from the invocation.

   Required change: add `src/agents/llm-recording.ts` to the cross-cutting impact list and describe how terminal-tool metadata is preserved without a closed three-name enum.

4. Downstream result consumers are named too generically for an architectural analysis.

   The analysis says `PlannerResult` / `ExecutorResult` / `ReviewerResult` types stay and projections move, but it should ground that claim in the actual consumers. The public contract types are in [../../../src/contracts/agent-execution.ts#L30-L79](../../../src/contracts/agent-execution.ts#L30-L79). The runtime consumes `PlannerResult` status and created-card data in the planner loop at [../../../src/runtime/runtime.ts#L677-L697](../../../src/runtime/runtime.ts#L677-L697), and applies card mutations from `PlannerResult` at [../../../src/runtime/runtime.ts#L822-L840](../../../src/runtime/runtime.ts#L822-L840). Reviewer results feed validation at [../../../src/runtime/runtime.ts#L453-L470](../../../src/runtime/runtime.ts#L453-L470).

   Required change: make the downstream-consumer section concrete enough that the design phase cannot miss where projections move and where typed result compatibility must be intentionally broken rather than accidentally preserved.

5. Position A should be flagged as compatibility-shaped, not presented neutrally.

   The open A/B/C deferred-activation options are acceptable for an analysis document; this is not the design phase. However, Position A says the adapter still fires when the planner only called `activate_card` and constructs a contract-recognized done signal on the agent's behalf. That preserves the current special-case behavior in a cleaner wrapper and risks violating both the brief's verifier-and-repair model and the project rule against backward-compatibility preservation.

   Required change: keep A/B/C open if desired, but explicitly mark Position A as carrying a backward-compatibility and autonomy risk. The analysis should not let the design phase treat "still synthesise" as equally architecture-first unless it is reframed as a real contract output owned by the tool invocation rather than a planner-result fabrication path in the adapter.

## Completeness Against F05/F06/F07

- F05 is covered well: the role union, role-to-schema map, role-to-tool-name map, adapter lookup, LLM options factory, terminal verifier, tool catalog, and contracts enum are all included.
- F06 is mostly covered, but incomplete until it names the parser compatibility fallback and the persisted `activate_card` unresolved/completion message consumers.
- F07 is covered conceptually, but the prompt line references must be corrected and the analysis should avoid overstating exact schema drift until the cited anchors point at the right lines.

## Self-Containment

No process back-references were found. The document does not rely on "as in r1", reviewer requests, approval markers, or sibling documents. It stands on its own.

## Open Questions

The analysis mostly keeps design questions open. A/B/C for deferred activations, contract location, schema rendering, repair-message format, analyst unification, recorder enum widening, and self-check treatment are correctly left for the design phase. The only required adjustment is to label compatibility-shaped options and existing compatibility code explicitly, so the design phase is not quietly biased toward preserving old behavior.

VERDICT: CHANGES_REQUESTED