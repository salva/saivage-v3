# F17 Approved

Round 1 reviewer approval for `no-agent-detail-endpoint`.

## Rationale

- The issue is a narrow observability gap: `GET /api/agents/:id` is missing while list, conversation, and latest LLM-exchange endpoints already exist.
- The proposed route is additive and architecture-first: it stays with the existing inline agent route cluster instead of introducing a migration shim or moving unrelated surfaces.
- The response shape is intentionally safe for monitoring and restart-persistence checks: counts and timestamps only, no conversation payload, no content, and no LLM request/response body leakage.
- The implementation plan reuses the existing persisted-session helpers and safety regex, and the test plan covers success, invalid ID, missing session, and missing auth.
- Documentation work includes the enforced operator-route table and design API narrative; validation should run the route/docs guard while accounting for any preexisting baseline drift.

## Links

- Issue: [00-issue.md](00-issue.md)
- Writer analysis: [01-analysis-r1.md](01-analysis-r1.md)
- Writer design: [02-design-r1.md](02-design-r1.md)
- Writer plan: [03-plan-r1.md](03-plan-r1.md)
- Route surface: [src/server/routes/runtime-config-notes.ts](../../../../src/server/routes/runtime-config-notes.ts)
- Session/message schemas: [src/schemas/validators.ts](../../../../src/schemas/validators.ts)
- Existing sibling route test pattern: [tests/server/agents-llm-exchange-route.test.ts](../../../../tests/server/agents-llm-exchange-route.test.ts)
- Operator route inventory: [docs/operation.md](../../../../docs/operation.md)
- API narrative: [docs/design/server-api.md](../../../../docs/design/server-api.md)