# probe-llm-contract

Live wire-contract probe for the LLM gateway. Per-provider × per-role
(`planner`, `executor`, `reviewer`, `analyst`), the script issues a minimal
request through shared transport resolution and `LlmProviderGateway`, then
reports the outcome on stdout, one JSON line per row.

## Invocation

Run inside (or against) a project that has a populated
`.saivage/saivage.yaml`:

```bash
node /opt/saivage-v3/dist/src/scripts/probe-llm-contract.js [projectRoot]
```

If `projectRoot` is omitted, `process.cwd()` is used.

The script reads only `<projectRoot>/.saivage/saivage.yaml`. It never reads
`.saivage/auth-profiles.json`. Candidates whose selected provider/account would
require auth-profile resolution are skipped with `reason:
"requires_explicit_auth_profile"` or `"requires_implicit_auth_profile"`.
Candidates resolvable from inline configuration use the same transport/local
setup path as production, including OpenAI Codex credential validation and
derived `chatgpt-account-id` handling.

## Output

Each row has the shape:

```json
{"provider":"openai","role":"planner","model":"gpt-4o-mini","status":"ok","ms":712}
{"provider":"openai","role":"analyst","model":"gpt-4o-mini","status":"error","ms":830,"kind":"contract_mismatch","subtype":"terminal_tool_missing","error":"..."}
{"provider":"openai-codex","role":"executor","status":"skipped","ms":1,"reason":"requires_implicit_auth_profile"}
```

`status` is one of:

- `ok` — the gateway returned a `tool_calls` or `message` result without
  raising; the wire contract is intact.
- `error` — the gateway raised. `kind` is the `LlmFailure` discriminant
  (`contract_mismatch`, `auth_permanent`, `rate_limit`, …). For
  `contract_mismatch`, `subtype` is one of:
  - `terminal_tool_missing` — model returned no tool call when the terminal
    tool was required.
  - `terminal_tool_unexpected` — model called a tool other than the terminal
    one in terminal phase.
  - `tool_arguments_invalid_json` — arguments string did not parse as JSON.
  - `tool_arguments_schema_violation` — arguments parsed but failed the
    envelope schema.
  - `legacy_message_shape` — model produced a content/JSON envelope instead of
    a tool call (a legacy-shape regression).
  - `unknown` — classifier could not narrow further.
- `skipped` — no candidate could be probed without violating the probe's
  no-auth-profile-read contract (`no_supported_model`,
  `requires_explicit_auth_profile`, or `requires_implicit_auth_profile`).

## Exit code

- `0` only when every emitted row is `status: "ok"`.
- `1` when any row is `error` or `skipped`.
- `2` if the script itself crashed (config could not be loaded, etc.).

A non-zero exit is not automatically a release blocker — the probe is a
measurement instrument. Treat `error` rows with `kind: "contract_mismatch"`
as wire bugs (open a follow-up under F12 or the matching feature),
`auth_permanent` or `local_setup_error` as configuration drift, and `skipped`
as informational.
