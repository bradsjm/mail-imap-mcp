# Completion Plan

This plan translates the phased TDS into incremental, testable stages based on current `src` status. Each
stage should be deliverable independently with clear verification steps.

## Stage 0 — Contracts, Schemas, and Guards (foundation)

**Scope**

- Finalize Zod input/output schemas for all v1 tools.
- Register JSON Schemas for MCP `tools/list` using Zod → JSON Schema.
- Define shared types for mailbox/message summaries and IDs.
- Enforce baseline safety: secret scrubbing, read-only default, confirm gate for destructive actions.

**Deliverables**

- `src/` schemas and model types for every tool.
- Tool registration includes accurate `inputSchema` for each tool.
- Structured error helpers (actionable, non-secret messages).

**Tests**

- Schema validation tests (valid/invalid inputs).
- Tool list snapshot test (names, descriptions, input schemas).
- Secret scrubbing redaction test (already present; extend if needed).

## Stage 1 — Read-Only MVP (browse/search/fetch)

**Scope**

- Implement: `mail_imap_list_mailboxes`, `mail_imap_search_messages`, `mail_imap_get_message`.
- Add pagination with `limit` + `page_token` (stable within TTL window).
- Output shaping: concise summaries and bounded snippets.

**Deliverables**

- Stable `message_id` encoding (`account_id`, `mailbox`, `uidvalidity`, `uid`).
- Search supports common filters (from/to/subject, unread, date range).
- `get_message` returns headers + sanitized text snippet by default.

**Tests**

- List/search/get happy paths (mock IMAP or integration with a fixture account).
- Pagination stability (no duplicates/omissions).
- Size limits on snippets and summary format.

## Stage 2 — Safe Write Operations (minimal mutation)

**Scope**

- Implement: `mail_imap_update_message_flags`, `mail_imap_move_message`, `mail_imap_delete_message`.
- Enforce read-only mode defaults and explicit `confirm: true` for delete.

**Deliverables**

- Write operations blocked unless `MAIL_IMAP_WRITE_ENABLED=true`.
- Delete requires explicit confirmation and returns a concise summary.

**Tests**

- Safety gates (write ops rejected when disabled).
- Confirmation enforcement for delete.
- Flag/move operations update expected state.

## Stage 3 — Large Payload Handling (attachments/raw)

**Scope**

- Add attachment metadata in `get_message` without returning bytes by default.
- Optional `mail_imap_get_message_raw` behind size limits and explicit opt-in.

**Deliverables**

- Attachment metadata: filename, mime type, size, part id.
- Raw fetch bounded by `body_max_chars`/size limits with clear errors.

**Tests**

- Attachment metadata shape and bounds.
- Raw fetch size limit enforcement.

## Stage 4 — Hardening, Errors, and Ops

**Scope**

- Map IMAP/network errors to actionable messages.
- Add timeouts/retry strategy where safe.
- Expand structured audit logging with scrubbed args.

**Deliverables**

- Consistent error taxonomy for auth, network, mailbox/message not found.
- Optional lightweight health output (version/status) if needed.

**Tests**

- Error mapping unit tests.
- Audit log redaction checks for sensitive fields.
