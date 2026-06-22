# Playwright E2E findings — Saivage v3 / 10.0.3.170

## Bug inventory

### E01 (HIGH, web): WS store handler crashes on every event with `TypeError: Cannot use 'in' operator to search for 'intent' in completed`

- **Location**: [web/src/stores/runtime-read-model.ts](../../../../web/src/stores/runtime-read-model.ts#L160-L195) `mergeRuntimeSummaryPatch`.
- **Symptom (console)**:
  ```
  [store:ws] Store event handler error TypeError: Cannot use 'in' operator to search for 'intent' in completed
  ```
  Reproduced on every WS event after sending an analyst query (and almost every runtime status change).
- **Root cause**: The function reads `content.runtimeSummary ?? content.summary`. Some WS events carry `summary: "completed"` (a string status), but the code blindly does `if (summary) ... if ('intent' in summary) ...`. The `in` operator throws when its right-hand side is not an object. Type-cast hides the bug at compile time.
- **Architecture-first fix**: at the boundary, require the field to be an object: `if (summary && typeof summary === 'object' && !Array.isArray(summary)) { ... }`. Do the same for the outer `if ('intent' in content)`/`'currentRun' in content`/etc — every bare `'X' in content` must be guarded by an `isObject(content)` check upstream.
- **Verification**: Add a vitest case that feeds `mergeRuntimeSummaryPatch({ summary: 'completed' })` and asserts it returns `{}` without throwing. Then a positive case with the full nested summary shape.

### E08 (MEDIUM, web): Analyst markdown tables not rendered

- **Symptom**: Assistant message body contains a GFM table (`| ID | Type | Title | ... |`) but the UI displays the raw `|`-delimited text on a single visual line — newlines and table grid not applied. Verified in: Dashboard, Cards, Debug analyst chat panels.
- **Root cause (likely)**: Markdown renderer either disables GFM tables or doesn't preserve newlines (assistant message inserted as plain text with no `white-space: pre-wrap` and no markdown parser).
- **Fix sketch**: Confirm whether assistant text bodies are passed through a markdown renderer at all. If not, route assistant text through the existing markdown component used elsewhere; if yes, enable GFM tables + lists + ensure newlines preserved. Add vitest snapshot for a table + a code-fence body.

### E09 (LOW-MEDIUM, web): Analyst tool-call group label stays `pending` after the tool result has clearly returned

- **Symptom**: `group "tool list_cards pending"` chip in analyst chat even after the next assistant message text fully consumes the result and renders the table. Reproduced consistently after every tool invocation.
- **Root cause (likely)**: Pending-attribution registry keeps the chip in `pending` until a fetched persisted `tool_result` message with the matching `tool_call_id` arrives, but the per-row persistence flip (F05 B5) may have changed the matching key or the chip lookup never sees the new row shape.
- **Fix sketch**: Inspect `usePendingToolInvocations`/`analystChat` store registration of pending chips against incoming `tool_result` rows. Likely mismatch in `tool_call_id` extraction after the persistence single-row flip.

### E04 (operational, NOT a code bug): Reset workflow leaves `agents/{sessions,messages,llm-exchanges}` root-owned after SSH-as-root reset

- After `ssh root@10.0.3.170 'mkdir agents/sessions ...'`, the service (running as `salva`) gets `EACCES` on first analyst write → cascading 500s on `/api/chats` and `/api/ws-ticket`.
- Operational note: any reset must `chown -R salva:salva` the recreated dirs. This is documented in [.github/skills/saivage-project-reset/SKILL.md](../../../../.github/skills/saivage-project-reset/SKILL.md) implicitly but should be explicit.

### E05 (LOW, web): Dashboard refresh button is disabled with no tooltip explaining why

- Shows `↻` button greyed out indefinitely on initial dashboard mount; only the WS-driven reconnect re-enables it. Could mislead an operator into thinking the dashboard is frozen.

### E06 (LOW, web): Time-format inconsistency across dashboard rows

- "Updated 07:25 PM" and "Last REST Sync 08:50 AM" appear in the same panel — one uses 12h with leading zero, the other doesn't. Cosmetic.

### E07 (LOW, docs/web): Errors panel still displays legacy event types (`invocation_failed`/`failureClass`/`recoveryAction`)

- Errors panel preserves historical rows. The pre-existing rows from before M11 still carry the deleted event types. Acceptable per architecture-first (legacy data eventually rotates out), but worth confirming the panel correctly handles BOTH new `llm_attempt` AND old `invocation_failed` rendering paths during the transition window — or that legacy rows have been purged from the live runtime via the `.saivage/runtime/events.jsonl` reset.

### Recovery hypothesis E10/E11 (root cause of pre-existing planner failures, 13h ago — now fixed by M01-M11)

- E10: DeepSeek 400 `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'` — pre-M05 message stitching bug; F05 B5 single-row persistence + new `parseToolCallMessage` should prevent this from recurring (each tool_call has exactly one matching tool_result row).
- E11: Kimi-K2.6 400 `You cannot specify response format and function call at the same time` — pre-M05 wire shape bug; F05 B2 dropped `response_format` from both gateways and F06 B6 enforces tools-only chat shape.
- **Verification needed**: trigger a fresh planner invocation (cards G2/G3 are still in backlog) and watch `Errors` panel + `journalctl` for any recurrence.

## Priority order for execution

1. **E01** — every WS event currently crashes the runtime read-model handler; fixes are 2-line guards + 1 vitest case.
2. **E09** — tool-call chip pending-state UX bug; isolated to analyst store.
3. **E08** — markdown table rendering; small footprint, high user-visible impact.
4. **E05/E06/E07** — small follow-ups, can be batched into a polish PR.
