# F21 — Functional analysis (r1)

## Symptom

`GET /api/cards/<id>/diff?from=1&to=last` returns HTTP 400 with body
`{ "error": "from and to query parameters are required positive integers" }`.
Callers cannot ask for "diff against the current version" without first learning the latest
`version_seq` from `/api/cards/<id>/history` — and `/history` is broken (see
[F12](../F12-card-history-empty/00-issue.md), recently absorbed by F13). Evidence:
[tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T44,
[tmp/.../t44-diff.json](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-diff.json),
[tmp/.../t44-diff-1-1.json](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t44-diff-1-1.json).

## Code path that produces the 400

The route is declared in the operator contracts and mounted through `ContractRuntime`. The
hand-wired file [src/server/routes/cards.ts](../../../../src/server/routes/cards.ts) only
delegates to `registerOperatorContractRoutes`.

1. Contract declaration —
   [src/contracts/operator-api.ts#L155](../../../../src/contracts/operator-api.ts#L155):
   ```ts
   export const CardDiffQuerySchema = z.object({
     from: z.string().min(1),
     to: z.string().min(1),
   });
   ```
   Both `from` and `to` are required strings; no alias is recognised at the schema layer.
   The contract entry is registered at
   [src/contracts/operator-api.ts#L356-L368](../../../../src/contracts/operator-api.ts#L356-L368).

2. Handler — [src/server/routes/operator-contracts.ts#L135-L146](../../../../src/server/routes/operator-contracts.ts#L135-L146):
   ```ts
   'cards.diff': ({ params, query }) => {
     const id = (params as unknown as { id: string }).id;
     const { from: fromRaw, to: toRaw } = query as unknown as { from: string; to: string };
     const card = store.read(id);
     if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
     const from = Number.parseInt(fromRaw, 10);
     const to   = Number.parseInt(toRaw, 10);
     if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0)
       return { statusCode: 400, body: { error: 'from and to query parameters are required positive integers' } };
     try { return { body: { diff: redactValue(store.diffCard(id, from, to)), from, to, card_id: id } }; }
     catch (err) { ... }
   },
   ```
   `Number.parseInt('last', 10)` is `NaN`, so the validator falls through to the 400 branch.

3. Underlying store API — [src/cards/card-store.ts#L905](../../../../src/cards/card-store.ts#L905)
   `diffCard(id, fromSeq, toSeq)` is purely numeric; it has no concept of "current".
   The "current" `version_seq` is already on the card record (`store.read(id).version_seq`,
   set at [src/cards/card-store.ts#L754](../../../../src/cards/card-store.ts#L754) at create,
   bumped at [src/cards/card-store.ts#L825](../../../../src/cards/card-store.ts#L825) on mutate).

## What "last" / "current" should mean

`store.read(id).version_seq` is the integer to use. By construction it is `>= 1` for any
existing card. Note that `getCardAt(id, current.version_seq)` returns the live by-id record
(short-circuit at [src/cards/card-store.ts#L897](../../../../src/cards/card-store.ts#L897)),
so resolving `to=last` to that integer is safe and does not require touching the JSONL.

## Why callers hit this in practice

`diff_card` exposed to agents already handles this server-side:
[src/agents/analyst-tools.ts#L136](../../../../src/agents/analyst-tools.ts#L136) defaults
`toSeq` to `card.version_seq` and `fromSeq` to `Math.max(1, toSeq - 1)`. The Zod input there is
`fromSeq` / `toSeq` as `z.number().int().optional()`
([src/tools/agent-tools.ts#L103](../../../../src/tools/agent-tools.ts#L103)). The operator HTTP
surface lacks the equivalent defaulting and alias support, so external clients and humans
hit the 400 the agent tool already insulates internal callers from.

## Web client and tests today

- Web client wrapper passes integers as strings:
  [web/src/api/client.ts#L191-L196](../../../../web/src/api/client.ts#L191-L196). It would
  benefit from a default-`to` shortcut but currently always supplies both.
- Backend test asserts the present strict behaviour:
  [tests/api/cards-history.test.ts#L109-L110](../../../../tests/api/cards-history.test.ts#L109-L110)
  treats `from=a&to=2` as a 400. That assertion remains correct under the proposed fix —
  `a` is not `last`/`current`/an integer, so it must still 400.
- Playwright fixture returns a canned response keyed on the path
  `/api/cards/card-smoke/diff`
  ([tests/playwright/fixtures/operator-rest-fixtures.ts#L187](../../../../tests/playwright/fixtures/operator-rest-fixtures.ts#L187));
  no change required.

## Interaction with other findings

- F12/F13: those finds rewrite the write path of the card store; they do NOT touch
  `diffCard`, `getCardAt`, or the diff route. F21 is orthogonal and lands after F12/F13
  only because the live `/history` endpoint must work to make the F21 behavioural fix
  end-to-end verifiable through the same dashboard flow. It does not block on F12/F13 for
  code correctness — it can ship and pass focused tests independently.
- F19 (RuntimeStateMachine ownership) does not interact with the diff route.

## Severity / transversality

- Bad DX (over-strict parser).
- Local: 1 contract schema (`CardDiffQuerySchema`), 1 handler (`cards.diff` in
  `operator-contracts.ts`), 1 backend test (`tests/api/cards-history.test.ts`), optional 1
  web client helper. No on-disk format change. No state-machine impact. No new dependency.

## Acceptance behaviour expected from the fix

1. `GET /api/cards/<id>/diff?from=1&to=last` returns 200 with `from=1`, `to=<current
   version_seq>`, `card_id=<id>`, and a `diff` array equivalent to
   `store.diffCard(id, 1, current.version_seq)`.
2. `GET /api/cards/<id>/diff?to=last` (no `from`) returns 200 with `from = max(1, to-1)`,
   `to=<current version_seq>`.
3. `GET /api/cards/<id>/diff` (neither parameter) returns 200 with `to=<current
   version_seq>`, `from = max(1, to-1)`.
4. `current` is accepted as a synonym of `last`.
5. Out-of-range numeric pivots still 400 (e.g. `from=0`, `to=-1`, `to=last&from=last+1`).
6. Non-integer non-alias values still 400 (e.g. `from=a`, `to=2.5`).
7. Missing card still 404 (precedence: 404 before pivot resolution would be observable, so
   the existing order — read card first, then validate query — is preserved).
8. `from > to` after resolution still 400 with a clear message.
