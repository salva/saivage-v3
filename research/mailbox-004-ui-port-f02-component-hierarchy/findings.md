# F02 component hierarchy — research findings

Date: 2026-05-26  
Task: `t1-scope-check-and-proposals`  
Stage: `mailbox-004-ui-port-f02-component-hierarchy`

## Executive summary

The F02 mailbox proposal is still relevant to the active tree. F01 design tokens/patterns have landed, but there is no `web/src/components/ui`, `content`, or `conversation` hierarchy yet. The old `web/src/components/code` directory and single-file `web/src/utils/tool-presenters.ts` still exist. Current UI surfaces still duplicate primitive CSS and markup for buttons, chips, cards, status dots, overlays, message bubbles, tool chips, code blocks, markdown, and JSON-like output.

The best next step is **bounded implementation after review**, not a blind literal execution of the historical 15-commit SPEC. I produced:

- `architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/scope-check.md`
- `architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/proposals/proposal-direct.md`
- `architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/proposals/proposal-restructure.md`

## What the Coder needs to know

1. F01 preconditions are satisfied: `patterns.css` and `semantic.css` exist; most F02 pattern extensions are present.
2. `.tablist > .pill[aria-pressed="true"]` was not found in `patterns.css`; add it if the F02 implementation uses active tablist pills.
3. No F02 component directories exist yet; this is a clean hierarchy introduction.
4. Old `components/code` imports must be updated atomically if the directory is deleted.
5. Root lint currently uses `/.eslintrc.json` and `npm run lint` only lints `src/` plus import-boundary script, not `web/src`; F02 boundary enforcement needs explicit implementation.
6. There is substantial unrelated dirty workspace state. Do not revert unrelated changes.

## Key evidence

- Mailbox proposal: `proposals-for-review/2026-05-26-51-ui-port-F02-component-hierarchy.md`
- F01 implementation log: `architecture-audit/mailbox-003-ui-port-f01-design-tokens/implementation-log.md`
- Current UI map: `architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/research-current-ui-map.stdout.log`
- Selector inventory: `architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/research-selector-inventory.stdout.log`
- ESLint config discovery: `architecture-audit/mailbox-004-ui-port-f02-component-hierarchy/research-eslint-config.stdout.log`

## Recommended reviewer focus

Review should decide between:

- **Direct:** implement all 14 requested primitive components now and migrate chat/agent/card/debug/auth/layout surfaces in one bounded mailbox cycle, avoiding F03/F04/F05 overreach.
- **Restructure:** establish only `ui/` + `content/` foundation now and defer full conversation/presenter work to the already queued F03/F04/F05 mailbox items.

My recommendation is Direct if the Coder can keep F03/F04/F05-specific presenter/timeline work minimal; otherwise Restructure is safer and cleaner sequencing.
