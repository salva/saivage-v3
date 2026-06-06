# F26: Agent Setter Injection Creates Hidden Initialization Order Dependency

**Severity:** MEDIUM  
**Transversality:** LOCAL  
**Category:** Missing abstraction / Hidden coupling  
**Verdict:** PARTLY SOUND — setter injection exists; `llmCallFn` is the strongest crash risk

## Summary

`AgentAdapter` uses 5 setter methods for dependency injection, creating an undocumented initialization order. Additionally, `RuntimeApplication.analystDeps` is a getter that rebuilds the deps object on every access, closing over mutable `let` bindings.

## Corrected Evidence

- `src/agents/agent-adapter.ts:388-410` — Five setter injection methods
- `src/agents/agent-adapter.ts:722-723` — `llmCallFn` is asserted non-null with `!` operator (crash if not set)
- `src/application/runtime-composition.ts:126-132` — `analystDeps` getter rebuilding deps on every access

Overstatement corrected: not all five setters are equally unsafe. Several dependencies are intentionally optional and accessed through getters with defaults. The strongest runtime crash case is `llmCallFn` which is asserted with `!`.

## Clean Architecture Approach

Constructor-inject required dependencies (LLM call function, config, project root). Use explicit optional ports for optional capabilities (MCP manager, skills engine, content supervisor). Remove mutation-order requirements from `RuntimeApplication`. If late binding is needed, use a resolved promise pattern rather than nullable fields asserted with `!`.