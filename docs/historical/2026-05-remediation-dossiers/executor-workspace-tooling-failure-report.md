> **Historical/Audit Artifact — Not Current Operator Instructions**  
> This page records an incident report from an earlier stage. It is not authoritative for current Saivage v3 behavior unless a current active doc explicitly revalidates it against current source and tests.

# Executor Workspace Tooling Failure Report

<!-- doc-authority
status: historical
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/agents/workspace-tools.ts:1
-->

> **Authority status: historical.** This page is retained for provenance only and has no current replacement yet. See `docs/documentation-inventory.md` for disposition `keep`.

Date: 2026-05-15

## Summary

The failed the target project task was not caused by the modeling code requested by the card. It exposed a higher-level execution design problem in Saivage v3: executor agents were instructed to create files and run commands, but the live agent adapter did not reliably provide a first-class workspace tool surface that could do that work in the project root.

The immediate failed card was `code-3`, "Implement expanding-window baseline evaluation". Its recorded error said the executor could not enter `/work/target-project`. A deeper inspection showed that several earlier cards were marked done even though their promised files did not exist in `/work/target-project` or the host `target-project` checkout. Runtime events also logged artifact registration failures such as "Source file not found" for files the agents claimed to have produced.

## Evidence

- The live service is configured with `WorkingDirectory=/work/target-project`.
- The live project directory contained `.saivage` and `.saivage-work` state, but no generated project files such as `pyproject.toml`, `src/target_v2/...`, `tests/...`, or docs.
- `code-3` failed before implementation because the executor reported that `/work/target-project` was unavailable for `cd`.
- Earlier completed cards registered artifacts whose source files were missing from the real project root.
- The live model routing prioritized `openai-codex`, and `AgentAdapter.createLlmCallFn()` stripped tool definitions for that provider before making calls.
- The executor prompt and runtime skill context advertised command/file capabilities such as process execution, but `AgentAdapter` only handled `load_skill` and `mcp_tool_call`. The live project only had Playwright configured as an MCP server, not filesystem or shell tools.

## Root Cause

The runtime treated executor output JSON as an authoritative report of completed work. It then attempted to register any listed artifacts, but artifact registration failures were logged as secondary errors and did not invalidate a successful executor result.

This created a false-success path:

1. Planner created executable cards.
2. Executor model received prompts saying it should write files and run commands.
3. The adapter did not give the executor native project file and shell tools in the live provider path.
4. The model could still return JSON claiming work was done.
5. Runtime marked the card done before or despite missing artifact source files.
6. Later cards depended on files that did not exist, exposing the mismatch.

The failed `cd /work/target-project` was therefore a symptom. The design issue was that the execution layer had no enforced, project-scoped tool contract for concrete filesystem and command work.

## Design Findings

### Missing Execution Boundary

Saivage has a process runner, artifact registry, card store, and agent session persistence, but the real LLM adapter did not expose project-scoped file and command tools as native function tools. The prompt implied capabilities that were not actually available.

### Provider-Specific Tool Disablement

The OpenAI Codex transport supports tool definitions, but the adapter removed tools for `openai-codex`. Since the live configuration gave that provider top priority, the executor was normally invoked without tools.

### Tool-Call Round-Trip Weakness

Tool outputs were persisted as generic messages without preserving provider tool call identifiers. That is fragile for providers that require a tool output to reference the original function call.

### Artifact Registration Was Too Weak As Verification

Artifact registration copied existing files into `.saivage-work`, but missing source files only produced logged errors. This made artifact failure visible in logs but not strong enough to prevent false completion.

## Impact

- Cards can be marked done without corresponding files existing in the project root.
- Downstream cards can fail for environmental reasons that are really earlier false completions.
- Operators see a plausible card tree but an empty or incomplete workspace.
- Live project recreation is unreliable because the system lacks a hard connection between executor claims and workspace mutations.

## Corrective Direction

The clean fix is to make workspace mutation an explicit runtime capability instead of relying on prompts or external MCP availability. Executor agents must use native project-scoped tools for file and command work, and those tool calls must be serialized correctly for the selected provider.
