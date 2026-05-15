> **Historical/Audit Artifact — Not Current Operator Instructions**  
> This page records a remediation plan from an earlier stage. It is not authoritative for current Saivage v3 behavior unless a current active doc explicitly revalidates it against current source and tests.

# Executor Workspace Tooling Remediation Plan

Date: 2026-05-15

## Goal

Fix the the target project recreation failure at the execution architecture level, not by manually creating missing files or patching the failed card. Saivage executors must have a real project-scoped way to inspect files, write files, and run verification commands in the project root.

## Plan

### 1. Add Native Workspace Tools

Create a first-class workspace tool module for real agent execution:

- `list_project_files` lists project files while omitting Saivage internals.
- `read_project_file` reads files safely through existing project-root containment and secret-redaction logic.
- `write_project_file` writes project files atomically while blocking `.saivage` and `.saivage-work` state mutation.
- `run_project_command` runs commands through the existing process runner with project-root environment and captured logs.

Acceptance criteria:

- Tools resolve paths inside the active `projectRoot`.
- Writes outside the project root are rejected.
- Saivage credential/runtime state cannot be modified through workspace tools.
- Command output is captured and returned to the agent.

### 2. Wire Workspace Tools Into AgentAdapter

Expose the workspace tools as normal function tools to planner, executor, and reviewer roles, with write and command tools restricted to executors.

Acceptance criteria:

- The executor sees the workspace tools in its function-tool list.
- `processToolCall()` executes workspace tools directly against `AgentAdapter.projectRoot`.
- Tool errors are returned as tool errors instead of being hallucinated as successful work.

### 3. Preserve Provider Tool Call Identity

Persist `tool_call_id` on agent messages and serialize tool-call messages correctly for both OpenAI-compatible chat completions and OpenAI Codex responses.

Acceptance criteria:

- Tool results reference the original provider call ID.
- Persisted assistant tool-call messages can be replayed into follow-up model calls.
- OpenAI Codex receives tools instead of having them stripped by the adapter.

### 4. Update Executor Instructions

Make the executor prompt explicit that filesystem and command work must go through `list_project_files`, `read_project_file`, `write_project_file`, and `run_project_command`, and that it must not claim success unless tool calls succeeded.

Acceptance criteria:

- The system prompt matches the real tool contract.
- Agents have proper context about how to perform concrete work.

### 5. Regression Tests

Add focused tests for the workspace tools and update existing tool-surface tests.

Acceptance criteria:

- Workspace tools can list, read, write, and run commands in a temp project.
- Workspace tools reject path escapes and Saivage internal writes.
- Existing load-skill and MCP tool tests pass with the expanded tool surface.
- Typecheck passes.

### 6. Live Recreation Validation

After implementation and build:

- Rebuild Saivage v3.
- Refresh the live LXC installation from the rebuilt package.
- Reset `target-project` again, preserving only `.saivage` credentials and required configuration.
- Recreate the clean target objective.
- Restart the live service.
- Watch cards and runtime events until project files are actually created under `/work/target-project` and visible from the host project root.

If the recreation still fails, repeat the debugging loop from the new failure evidence rather than manually filling the workspace.
