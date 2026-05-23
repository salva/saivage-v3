# F21 — r1 review

Approved. I found no blocking issues in the functional analysis, recommended design, or implementation plan.

- The cited code matches the current repo: `CardDiffQuerySchema` requires `from` and `to` as non-empty strings, `cards.diff` reads the card and then parses both query values with `Number.parseInt`, and `CardStore.diffCard` / `getCardAt` remain integer-version APIs. `to=last` therefore reaches the existing 400 exactly as described.
- Design A is the right scope for F21: widening the HTTP query schema to optional `last` / `current` / positive-integer-string pivots and resolving defaults in the route keeps alias semantics at the operator API boundary while preserving numeric store APIs and the existing response shape.
- The F13 relationship is correctly characterized as orthogonal. F13/F12 are history/write-path repair work; F21 is a read-path query parsing/defaulting fix around `cards.diff` and can be tested independently once the route has a card with history.
- The plan uses the right validation shape: `npm run typecheck`, focused Jest with `NODE_OPTIONS=--experimental-vm-modules ... --runInBand --forceExit`, host `npm run build`, SSH restart of `saivage-v3-getrich.service` on `10.0.3.170`, and health/API curl probes. No rsync is proposed.
- Non-blocking implementation note: the design snippet contains an explanatory inline comment inside the rewritten handler. That is not a reason to reject the plan, but the actual patch should keep code comments sparse and avoid adding comments outside the edited diff region.

VERDICT: APPROVED