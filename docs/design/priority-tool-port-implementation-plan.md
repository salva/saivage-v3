# Priority Tool Port Implementation Plan

This plan ports and replaces the selected Saivage v2 non-runtime tools in Saivage v3:

- Priority 1: `read`, `write`, `glob`, `grep`, `edit`, `apply_patch`.
- Priority 3: `skill`.
- Priority 5: `websearch`, `webfetch`.

The work replaces current v3 agent-facing names rather than adding compatibility aliases. Runtime, planning, card-control, git, RAG, and memory tools remain out of scope.

## Goals

- Use the v2 tool names and field names in the v3 unified tool catalog.
- Preserve v3's project-root confinement, secret-path blocking, blocked-write policy, and durable process/event auditing where applicable.
- Remove the replaced names from agent-facing planner/executor/reviewer tool surfaces.
- Keep analyst host-inspection tools separate unless a later analyst-specific change explicitly replaces them.
- Add tests that fail if both old and new names are exposed together.

## Replacement Matrix

| Ported v2 tool | Replaces current v3 tool(s) | Target roles | Required behavior |
| --- | --- | --- | --- |
| `read` | `read_project_file` for project agents. | planner, executor, reviewer | Read project files or directories. Support `path`, `offset`, `limit`, and `read_mode`. Directory reads return sorted capped entries. File reads return line windows for text. Secret-bearing paths remain blocked/redacted according to v3 policy. |
| `write` | `write_project_file`. | planner, executor | Create or replace project files. Support `path` and `content`. Keep v3 write blocks for `.saivage`, `.saivage-work`, credentials, and blocked paths. |
| `glob` | `list_project_files`. | planner, executor, reviewer | Search project files using `directory`, `pattern`, and `max_results`. Skip `.git`, `node_modules`, `.saivage`, `.saivage-work`, generated build folders, and existing v3 skipped directories. |
| `grep` | No direct v3 tool. | planner, executor, reviewer | Search text file contents using `pattern`, `path`, `include`, and `max_results`. Confine all reads to the project root and skip blocked/secret paths. |
| `edit` | No direct v3 tool. | planner, executor | Replace exact text in one file using `path`, `old_string`, `new_string`, and `replace_all`. Fail when `old_string` is absent or ambiguous and `replace_all` is false. |
| `apply_patch` | No direct v3 tool. | planner, executor | Apply a pure unified diff from `patch`. Reject changes that target blocked paths or escape the project root. |
| `skill` | `load_skill`. | executor, reviewer, optionally planner if current prompts need it | Omit `name` to list skills; provide `name` to load one skill. Remove `load_skill` from the agent-facing catalog. |
| `websearch` | No direct v3 tool. | planner, executor, reviewer | Search the public web using `query` and `max_results`. Return candidate URLs, titles, and snippets. Enforce bounded timeouts and stable error codes. |
| `webfetch` | No direct v3 tool. | planner, executor, reviewer | Fetch HTTP(S) URLs using `url`, `read_mode`, `metadata_only`, `max_bytes`, `max_inline_bytes`, and `save_as`. Bound response size. Save only to authorized project paths. |

## Files To Change

| Area | Files |
| --- | --- |
| Unified definitions | `src/tools/definitions/index.ts`, new focused modules under `src/tools/` such as `project-file-tools.ts`, `web-tools.ts`, and updated `mcp-skill-tools.ts`. |
| Workspace dispatch | `src/agents/workspace-tools.ts`, `src/tools/workspace-tools.ts`, and any adapter that routes workspace tool calls. |
| Skill loading | `src/tools/mcp-skill-tools.ts`, skill index/loading code referenced by the existing `load_skill` path. |
| Web fetching | New v3 web utility module or ported equivalent from `saivage/src/mcp/builtins/web.ts`, adapted to v3 error/result contracts. |
| Prompts/docs | `docs/agents.md`, `docs/operation.md` if they list agent tools, relevant prompt assets under `src/agents/` or copied prompt assets. |
| Tests | `tests/agents/agent-adapter-non-planner-tools.test.ts`, `tests/agents/agent-adapter-planner-tools.test.ts`, focused unit tests for filesystem/edit/web behavior. |

## Implementation Steps

1. Add project filesystem tool definitions.

Create a focused module for `read`, `write`, `glob`, `grep`, `edit`, and `apply_patch`. The module should export `UnifiedToolDefinition` entries using v2 names and snake_case input fields.

2. Implement project filesystem handlers.

Move existing safe path normalization and blocked-write checks out of `src/agents/workspace-tools.ts` if needed so the new handlers can share them. Keep behavior project-local. Do not permit absolute paths outside the configured project root for project-agent tools.

3. Replace old workspace tool definitions.

Remove `list_project_files`, `read_project_file`, and `write_project_file` from `workspaceRuntimeTools`. Remove `start_and_wait` and `run_project_command` only when `run_command` is implemented in a later priority-2 wave; this plan does not replace command execution.

4. Add `grep`, `edit`, and `apply_patch` tests before exposing them broadly.

Cover exact-match failures, multi-match behavior, blocked paths, project-root escape attempts, binary/non-text files for `grep`, and patch attempts against blocked paths.

5. Replace `load_skill` with `skill`.

Change `mcp-skill-tools.ts` so the exported tool is named `skill` and accepts optional `name`. Preserve existing skill content loading. Add list behavior for omitted `name`. Remove `load_skill` from the stable tool order.

6. Add web tools.

Port the v2 websearch/webfetch behavior into a v3 module with v3 result envelopes. Keep HTTP(S)-only URL validation, bounded reads, metadata-only fetches, multimodal image support only if v3's LLM path can consume it, and `save_as` guarded by the same project write authorization as `write`.

7. Update tool catalog order.

In `src/tools/definitions/index.ts`, add the new names to `stableToolOrder` and remove the replaced names. Keep prompt reproducibility by choosing one stable order and asserting it in tests.

8. Update docs and prompt assets.

Replace references to `read_project_file`, `write_project_file`, `list_project_files`, and `load_skill` with the new v2-style names. Add `websearch` and `webfetch` to role matrices where appropriate.

9. Update parity and routing tests.

Adjust planner and non-planner tool-surface tests so they assert the new names. Add negative assertions that the replaced names are absent from agent-facing definitions.

10. Run validation.

Run `npm run validate:routine`, focused Jest tests for the changed handlers, and `npm test` if tool routing or prompt parity changes are broad.

## Non-Goals

- Do not port `run_command` in this wave.
- Do not port git tools in this wave.
- Do not port RAG tools in this wave.
- Do not port memory tools in this wave.
- Do not keep alias definitions for replaced names.
- Do not change analyst host-inspection tools unless they conflict with agent-facing catalog replacement.

## Risks And Controls

| Risk | Control |
| --- | --- |
| Agent prompts mention removed tool names. | Prompt/docs parity tests must fail until every current reference is updated. |
| `apply_patch` bypasses blocked paths. | Parse affected paths before applying and reject blocked or escaping paths before any write. |
| `grep` leaks secrets by scanning blocked files. | Use the same path filter as project reads and skip secret-bearing paths. |
| `webfetch save_as` writes to unsafe paths. | Route save authorization through the same guard as `write`. |
| `skill` list output becomes too large. | Return a compact skill index on omitted `name`; full content only for a named skill. |
| Existing validation scripts expect old names. | Update tests and docs together; do not land partial catalog/doc mismatch. |

## Acceptance Criteria

- `AgentToolCatalog` exposes `read`, `write`, `glob`, `grep`, `edit`, `apply_patch`, `skill`, `websearch`, and `webfetch` to the intended roles.
- `AgentToolCatalog` no longer exposes `read_project_file`, `write_project_file`, `list_project_files`, or `load_skill` to agents.
- Filesystem/edit tools enforce project-root confinement and v3 blocked-path policy.
- `skill` lists skills without `name` and loads one skill with `name`.
- `websearch` and `webfetch` return bounded structured results and stable validation/network error categories.
- `npm run validate:routine` passes.
- Focused unit tests cover the new tools' schemas, routing, success paths, and blocked-path failures.
