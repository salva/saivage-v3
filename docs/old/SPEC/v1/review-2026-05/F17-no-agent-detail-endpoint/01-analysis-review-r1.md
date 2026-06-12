# F17 -- Review (round 1)

Reviewed documents:

- [01-analysis-r1.md](01-analysis-r1.md)
- [02-design-r1.md](02-design-r1.md)
- [03-plan-r1.md](03-plan-r1.md)
- [00-issue.md](00-issue.md)

## Decision

Approved. The analysis and design correctly identify the missing bare agent-detail route and keep the fix additive, payload-light, and aligned with the existing inline Fastify route surface.

## Findings

- No blocking code-surface issue. The cited owner surface is real: [runtime-config-notes.ts](../../../../src/server/routes/runtime-config-notes.ts) contains the `/api/agents`, `/api/agents/:id/conversation`, and `/api/agents/:id/llm-exchange` handlers plus `readAgentSession`, `readAgentMessages`, `buildListedAgentSession`, and `SAFE_AGENT_ID_RE`; [validators.ts](../../../../src/schemas/validators.ts) defines the persisted agent session/message fields the proposed summary needs.
- The proposed `GET /api/agents/:id` contract is well scoped: 200 returns structural session metadata plus `message_count` and `last_activity_at`; 400/404/401 semantics mirror sibling route behavior; the response deliberately excludes `messages[]`, message `content`, tool payloads, and LLM request/response bodies.
- The test plan is adequate for r1. It mirrors the actual sibling test harness in [agents-llm-exchange-route.test.ts](../../../../tests/server/agents-llm-exchange-route.test.ts) and covers 200, 400, 404, and 401, with useful extra 200 variants for manifest+messages, messages-only, and manifest-only sessions.
- The docs plan correctly adds the new row to the enforced operator route inventory in [docs/operation.md](../../../../docs/operation.md) and updates the API narrative in [docs/design/server-api.md](../../../../docs/design/server-api.md). I ran `node scripts/verify-doc-routes.js`; current baseline drift already exists for `GET /api/agents/:id/llm-exchange` and two runtime-control anchors, so implementers should distinguish that preexisting drift from the new F17 row when validating.
- Non-blocking correction: deployment should follow the validation skill's bind-mounted GetRich-v2 flow exactly: host-side `npm run build`, SSH `systemctl restart saivage-v3-getrich.service && systemctl is-active ...`, then `curl http://10.0.3.170:8080/health`. The plan's in-container `git fetch` / `npm ci` fallback should be removed or marked obsolete, but this does not undermine the route design.

## Minor Notes

- Several writer-doc links to repo files appear one directory short from this dossier location (`../../../src/...` instead of `../../../../src/...`). The cited targets and code claims are still correct; fix the links opportunistically if these review dossiers are consumed as Markdown.
- If the implementation keeps the documented 500 contract wording as "redacted", either route the message through the existing redaction helper or remove that adjective from the contract. This is not a blocker because normal 400/404/401/200 behavior carries no payload leakage.

VERDICT: APPROVED