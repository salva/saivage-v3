# chats.send Contract Mismatch Diagnostic Summary

## Executive summary

Mailbox pre-check was clear. The current backend `ChatSendResponseSchema` requires a fully shaped assistant message (`id`, `role`, `kind`, `content`, `timestamp`) and required `toolInvocations`, while the web `ChatResponse` type and several web tests still model partial responses. The route returns `response.message` verbatim and only defaults `toolInvocations`, so malformed analyst/test-double output can trigger the exact `chats.send response did not match the operator API contract` error.

Primary artifacts:

- `architecture-audit/cycle-034-chat-send-contract-mismatch/scope-check.md`
- `architecture-audit/cycle-034-chat-send-contract-mismatch/proposals/proposal-direct.md`
- `architecture-audit/cycle-034-chat-send-contract-mismatch/proposals/proposal-restructure.md`

## Recommended path

Select `proposal-direct.md`: canonicalize the route success body and replace the stale web `ChatResponse` interface with the shared contract type. Add focused server/web regression tests.
