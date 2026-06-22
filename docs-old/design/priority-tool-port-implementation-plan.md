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
- Treat web access as a first-class policy surface with explicit egress limits, not as generic shell/MCP access.
- Invalidate old in-flight sessions deliberately at deployment time rather than preserving aliases.

## Replacement Matrix

| Ported v2 tool | Replaces current v3 tool(s) | Target roles | Required behavior |
| --- | --- | --- | --- |
| `read` | `read_project_file` for project agents. | planner, executor, reviewer | Read project files or directories. Support `path`, `offset`, `limit`, and `read_mode`. Directory reads return sorted capped entries. File reads return line windows for text. Secret-bearing paths are hidden from directory/search discovery and rejected for direct reads. |
| `write` | `write_project_file`. | planner, executor | Create or replace project files. Support `path` and `content`. Keep v3 write blocks for `.saivage`, `.saivage-work`, credentials, and blocked paths. |
| `glob` | `list_project_files`. | planner, executor, reviewer | Search project files using `directory`, `pattern`, and `max_results`. Skip `.git`, `node_modules`, `.saivage`, `.saivage-work`, generated build folders, existing v3 skipped directories, and secret-bearing paths. |
| `grep` | No direct v3 tool. | planner, executor, reviewer | Search text file contents using `pattern`, `path`, `include`, and `max_results`. Confine all reads to the project root and skip blocked/secret paths. |
| `edit` | No direct v3 tool. | planner, executor | Replace exact text in one file using `path`, `old_string`, `new_string`, and `replace_all`. Fail when `old_string` is absent or ambiguous and `replace_all` is false. |
| `apply_patch` | No direct v3 tool. | planner, executor | Apply a text-only unified diff from `patch`. Validate the complete patch before mutation. Reject binary patches, mode changes, submodule changes, external renames, blocked paths, symlink writes, and paths that escape the project root. |
| `skill` | `load_skill`. | executor, reviewer | Omit `name` to list skills; provide `name` to load one skill. Remove `load_skill` from the agent-facing catalog. Planner does not get `skill` in this wave; remove or rewrite active planner prompt references instead. |
| `websearch` | No direct v3 tool. | planner, executor, reviewer | Search the public web using `query` and `max_results`. Return candidate URLs, titles, and snippets. Enforce bounded timeouts, redirect limits, egress policy, and stable error codes. |
| `webfetch` | No direct v3 tool. | planner, executor, reviewer | Fetch HTTP(S) URLs using `url`, `read_mode`, `metadata_only`, `max_bytes`, `max_inline_bytes`, and `save_as`. Bound response size, block private/internal targets after DNS and redirects, and save only to authorized project paths. |

## Files To Change

| Area | Files |
| --- | --- |
| Unified definitions | `src/tools/definitions/index.ts`, new focused modules under `src/tools/` such as `project-file-tools.ts`, `web-tools.ts`, and updated `mcp-skill-tools.ts`. |
| Workspace dispatch | `src/agents/workspace-tools.ts`, `src/tools/workspace-tools.ts`, and any adapter that routes workspace tool calls. |
| Skill loading | `src/tools/mcp-skill-tools.ts`, skill index/loading code referenced by the existing `load_skill` path. |
| Web fetching | New first-class unified tool executor module or ported equivalent from `saivage/src/mcp/builtins/web.ts`, adapted to v3 error/result contracts, authorization policy, and audit records. |
| Prompts/docs | `docs/agents.md`, `docs/operation.md`, `src/runtime/phases/*phase-runner.ts`, `src/agents/prompts/system-prompt.ts`, prompt assets copied during build, and any tool matrix fixtures. |
| Tests | `tests/agents/agent-adapter-non-planner-tools.test.ts`, `tests/agents/agent-adapter-planner-tools.test.ts`, focused unit tests for filesystem/edit/web behavior. |

## Interface Contracts

The implementation must define exact Zod schemas and representative result shapes before changing role lists.

| Tool | Schema contract | Result contract |
| --- | --- | --- |
| `read` | `path: string`, `offset?: number`, `limit?: number`, `read_mode?: 'auto' | 'text' | 'multimodal'`. `offset` is zero-based. | File text returns `{ path, content, offset, limit, total_lines, truncated }`. Directory reads return `{ path, entries, offset, limit, total_entries, truncated }`. Unsupported binary files fail unless `read_mode` permits a supported multimodal response. |
| `write` | `path: string`, `content: string`. | `{ path, bytes, written: true }`. |
| `glob` | `directory: string`, `pattern: string`, `max_results?: number`. | `{ directory, pattern, matches, truncated }` where matches are project-relative paths. |
| `grep` | `pattern: string`, `path?: string`, `include?: string`, `max_results?: number`. | `{ pattern, matches, truncated }` where each match includes project-relative `path`, one-based `line`, and a capped text `preview`. |
| `edit` | `path: string`, `old_string: string`, `new_string: string`, `replace_all?: boolean`. | `{ path, replacements, bytes, edited: true }`. |
| `apply_patch` | `patch: string`. | `{ changed_files, applied: true }`. |
| `skill` | `name?: string`. | Without `name`, returns compact `{ skills }`; with `name`, returns the selected skill content. |
| `websearch` | `query: string`, `max_results?: number`. | `{ query, results, skipped? }`, with result `{ title, url, snippet }`. |
| `webfetch` | `url: string`, `read_mode?: 'auto' | 'text' | 'multimodal'`, `metadata_only?: boolean`, `max_bytes?: number`, `max_inline_bytes?: number`, `save_as?: string`. | Metadata returns headers/status only. Text returns inline text or a project-local stash path when over inline cap. Binary/image responses return bounded metadata or supported multimodal payloads only. |

All tools return v3 `ToolResult` envelopes and stable validation/security/network error categories. Schema snapshots and representative payload tests must lock these contracts before implementation is accepted.

## Cross-Tool Security Policy

Filesystem tools share one policy:

- Project-agent paths must resolve inside the configured project root.
- Secret-bearing paths and blocked runtime/credential paths are invisible to `read` directory listings, `glob`, and `grep` discovery.
- Direct access to a blocked or secret-bearing path fails with a permission error rather than returning redacted content.
- Mutating tools (`write`, `edit`, `apply_patch`, and `webfetch save_as`) reject blocked paths, secret paths, `.saivage`, `.saivage-work`, and symlink targets.
- Path checks use normalized project-relative paths and filesystem checks that prevent symlink traversal into blocked or external targets.

Web tools share one egress policy:

- Only `http` and `https` URLs are accepted.
- DNS results and every redirect target must be checked before connecting or following the redirect.
- Loopback, link-local, RFC1918/private, multicast, container-internal, and cloud-metadata address ranges are denied.
- Redirect count, header bytes, body bytes, response time, and inline text size are capped.
- URLs in logs and errors must avoid exposing credentials, query tokens, or fragments.
- `webfetch save_as` uses the same authorization guard as `write` after resolving the destination path.

## Implementation Steps

1. Add project filesystem tool definitions.

Create a focused module for `read`, `write`, `glob`, `grep`, `edit`, and `apply_patch`. The module should export `UnifiedToolDefinition` entries using v2 names and snake_case input fields.

2. Implement project filesystem handlers.

Move existing safe path normalization and blocked-write checks out of `src/agents/workspace-tools.ts` if needed so the new handlers can share them. Keep behavior project-local. Do not permit absolute paths outside the configured project root for project-agent tools. Apply the cross-tool security policy consistently before any file read, write, search, or directory traversal.

3. Replace old workspace tool definitions.

Remove `list_project_files`, `read_project_file`, and `write_project_file` from `workspaceRuntimeTools`. Remove `start_and_wait` and `run_project_command` only when `run_command` is implemented in a later priority-2 wave; this plan does not replace command execution.

4. Add `grep`, `edit`, and `apply_patch` tests before exposing them broadly.

Cover exact-match failures, multi-match behavior, blocked paths, secret discovery filtering, project-root escape attempts, binary/non-text files for `grep`, and patch attempts against blocked paths.

5. Replace `load_skill` with `skill`.

Change `mcp-skill-tools.ts` so the exported tool is named `skill` and accepts optional `name`. Preserve existing skill content loading. Add list behavior for omitted `name`. Remove `load_skill` from the stable tool order. Keep `skill` limited to executor and reviewer in this wave; remove active planner references to on-demand skill loading rather than exposing the tool to planner.

6. Add web tools.

Port the v2 websearch/webfetch behavior into a v3 module with v3 result envelopes. Implement these as first-class unified tool executors, not as `mcp_tool_call` wrappers and not as shell commands. Apply the web egress policy, bounded reads, metadata-only fetches, multimodal image support only if v3's LLM path can consume it, and `save_as` guarded by the same project write authorization as `write`.

7. Update tool catalog order.

In `src/tools/definitions/index.ts`, add the new names to `stableToolOrder` and remove the replaced names. Keep prompt reproducibility by choosing one stable order and asserting it in tests.

8. Update docs and prompt assets.

Replace references to `read_project_file`, `write_project_file`, `list_project_files`, and `load_skill` with the new v2-style names. Add `websearch` and `webfetch` to role matrices where appropriate. Check active prompts and phase runners by name, including `src/runtime/phases/*phase-runner.ts`, `src/agents/prompts/system-prompt.ts`, copied prompt assets, and generated tool matrix fixtures.

9. Update parity and routing tests.

Adjust planner and non-planner tool-surface tests so they assert the new names. Add negative assertions that the replaced names are absent from agent-facing definitions, and add per-role allow/deny assertions for mutating tools so reviewer cannot call `write`, `edit`, `apply_patch`, or `webfetch` with `save_as` unless a later policy explicitly permits it.

10. Plan the no-alias cutover.

Because replaced names are intentionally removed, deployment must stop or drain active runtimes before starting the new build. Persisted active sessions or queued model calls that still reference old tool names are intentionally invalid after the cutover. Document this in the release note/runbook for the implementation change.

11. Run validation.

Run `npm run validate:routine`, `npm run docs:verify`, focused Jest tests for the changed handlers, and `npm test` if tool routing or prompt parity changes are broad.

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
| `apply_patch` bypasses blocked paths. | Define a text-only patch grammar, parse every affected path, reject unsupported patch features, validate the whole patch before mutation, and fail atomically. |
| `grep` leaks secrets by scanning blocked files. | Use the same path filter as project reads and hide secret-bearing paths from discovery. |
| `webfetch` reaches internal services or exfiltrates metadata. | Enforce DNS/redirect egress policy, deny private/internal ranges, cap response sizes, and redact URL secrets in logs. |
| `webfetch save_as` writes to unsafe paths. | Route save authorization through the same guard as `write`, including symlink and blocked-path checks. |
| `skill` list output becomes too large. | Return a compact skill index on omitted `name`; full content only for a named skill. |
| Existing validation scripts expect old names. | Update tests and docs together; do not land partial catalog/doc mismatch. |
| Live deployments keep sessions with removed tool names. | Stop/drain runtimes and invalidate old active sessions as part of deployment. |

## Acceptance Criteria

- `AgentToolCatalog` exposes `read`, `write`, `glob`, `grep`, `edit`, `apply_patch`, `skill`, `websearch`, and `webfetch` to the intended roles.
- `AgentToolCatalog` no longer exposes `read_project_file`, `write_project_file`, `list_project_files`, or `load_skill` to agents.
- `skill` is exposed to executor and reviewer only; active planner prompts do not mention on-demand `skill` loading.
- Filesystem/edit tools enforce project-root confinement, hidden secret discovery, blocked mutation paths, and symlink-safe write checks.
- `skill` lists skills without `name` and loads one skill with `name`.
- `apply_patch` validates the full patch before mutation and rejects unsupported patch features.
- `websearch` and `webfetch` return bounded structured results and stable validation/security/network error categories.
- `webfetch` rejects private/internal/metadata targets after DNS resolution and redirects.
- `npm run validate:routine` passes.
- `npm run docs:verify` passes.
- Focused unit tests cover the new tools' schemas, routing, success paths, and blocked-path failures.
