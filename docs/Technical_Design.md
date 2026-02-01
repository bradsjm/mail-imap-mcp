# Technical Design Spec (Phased): `mail-imap-mcp`

## 1) Summary

Build an MCP server that provides a small set of outcome-oriented tools (target 5–10, hard cap 15) to access email via IMAP. Tools must use flat, strongly-typed JSON Schemas; return token-efficient summaries by default; paginate lists; and implement security guardrails (no secrets in outputs, least privilege, destructive confirmations, audit logging).

This TDS is phased so the server becomes useful early (read-only “browse/search/fetch”), then adds write operations and hardening.

## 2) Goals

- Enable an LLM to answer common “email triage” questions in 1 tool call (avoid multi-step workflows).
- Provide safe, least-privilege access to IMAP data with clear, actionable errors.
- Keep outputs concise and structured for LLM consumption; avoid raw mailbox/message dumps.
- Support deterministic pagination for large mailboxes/search results.
- Provide basic observability (structured logs + audit trail; optional metrics).

## 3) Non-Goals (for this server)

- SMTP / sending email (separate bounded context).
- Full-fidelity MIME rendering or full mailbox export.
- Provider-specific UI workflows (e.g., Gmail-specific labels UX) unless required.
- Long-lived interactive sessions the model must “manage” (avoid step-wise connect/configure tools).

## 4) Assumptions

- This server runs in a trusted local or controlled environment where credentials can be provisioned securely.
- IMAP accounts are configured outside the LLM prompt (recommended), and tools refer to them by `account_id`.
- Attachments and full bodies can be large; tools must default to summaries/snippets.

## 4.1) Implementation Stack (decided)

- **MCP:** `@modelcontextprotocol/sdk` over **stdio**
- **IMAP:** `imapflow`
- **Schemas:** `zod` for inputs + outputs; generate JSON Schema from Zod (e.g., `zod-to-json-schema`) when registering MCP tool `inputSchema`
- **MIME parsing:** `mailparser`
- **HTML sanitize + text extraction:** `sanitize-html` + `html-to-text`
- **Package manager:** `pnpm`

## 5) Constraints & Design Rules (from `architecture.md`)

- **Tool count:** recommended 5–10; hard cap 15.
- **Outcome-oriented tools:** each tool maps to a complete user capability.
- **Input schemas:** flat inputs; constrain strings/arrays with bounds and enums where possible.
- **Outputs:** concise summaries; paginate after ~10 items with `next_cursor`.
- **Security:** never return secrets; require `confirm: true` for destructive actions; least privilege; audit log all tool calls with scrubbed arguments.
- **Versioning:** semantic versioning; tool names + required fields are the public API.
- **Testing:** validate success paths, schema violations, pagination stability, confirmation behavior, and token efficiency.

## 6) Proposed Bounded Context

**“Read and manage email messages over IMAP for configured accounts.”**

Primary user outcomes:

- “Find emails about X from Y last week.”
- “Summarize the latest email from Alice and list the action items.”
- “Show me unread messages in Inbox; give me 10 at a time.”
- “Fetch the full body of a specific message when needed.”
- “Mark/move/delete a message with explicit confirmation.”

## 7) Proposed Tool Surface (v1)

Target: 7 tools (read + minimal write), leaving room for future expansion without exceeding the 15-tool cap.

### 7.1 Tool list (names are stable API)

1. `imap_list_mailboxes`
2. `imap_search_messages`
3. `imap_get_message`
4. `imap_get_message_raw` (optional; gated, size-limited)
5. `imap_update_message_flags`
6. `imap_move_message`
7. `imap_delete_message` (destructive; requires `confirm: true`)

### 7.2 Common conventions

- All tools accept `account_id: string`.
- All list/search tools accept `limit` (default 10, max 50) and `cursor?: string`.
- Prefer accepting a stable `message_id` instead of raw IMAP identifiers; if raw IDs are exposed, keep them explicit (e.g., `uid`, `uidvalidity`) and never overload meanings.
- All tools return:
  - A human-readable summary in `content[0].text`
  - Optional machine-parsable JSON in a second `content` item only when necessary (avoid by default)
  - `_meta.next_cursor` when more results exist
- Message bodies are truncated by default (`body_max_chars`), with explicit opt-in for more.

### 7.3 Example schemas (indicative; finalize in Phase 0)

#### `imap_search_messages` (indicative)

Inputs:

- `account_id` (required)
- `mailbox` (required; e.g., `"INBOX"`)
- `query` (optional free text; length-bounded)
- `from` / `to` / `subject` (optional; length-bounded)
- `unread_only` (optional boolean)
- `start_date` / `end_date` (optional; `format: "date"`)
- `limit` (optional int; default 10; max 50)
- `cursor` (optional string)

Output (text summary):

- “Found 37 messages in INBOX matching … Showing 10 (page 1). Next page token: …”
- Bulleted per-message summaries including stable identifiers (`message_id` / `uid`), date, from, subject, and a short snippet.

#### `imap_delete_message` (indicative)

Inputs:

- `account_id` (required)
- `mailbox` (required)
- `message_id` (required)
- `confirm` (required boolean; must be `true`)

Output:

- “Deleted message … from … (subject …).”

## 8) Data Model (conceptual)

Use strongly-typed internal models (e.g., Pydantic models or TypeScript interfaces) for:

- `AccountConfig` (non-secret metadata + secret references)
- `MailboxSummary` (name, delimiter, message counts if available)
- `MessageSummary` (stable id, date, from, to, subject, flags, snippet)
- `MessageDetail` (headers subset, body snippet, attachment metadata)
- `AttachmentSummary` (filename, mime type, size bytes, part id)

### 8.1 Message identity (recommended)

Define a stable, explicit message identifier that encodes the minimal IMAP facts needed to re-fetch:

- `message_id := "imap:" + account_id + ":" + mailbox + ":" + uidvalidity + ":" + uid`

Notes:

- Moving a message to a different mailbox typically changes both mailbox and UID (server-dependent). Treat moved messages as “new identity” in the destination mailbox.
- Tool responses should include both `message_id` and its components (`mailbox`, `uidvalidity`, `uid`) to aid debugging without ambiguity.

### 8.2 Pagination strategy (stdio-safe)

Because stdio MCP servers are typically stateless across processes, `cursor` must be self-contained or reference an in-memory cache:

- **Preferred (stable + compact):** cache the UID result set in-process keyed by an opaque cursor id (TTL-bounded), and return that cursor as `cursor`.
- **Fallback (fully self-contained):** encode `{ mailbox, query, sort, offset, snapshot: { uidvalidity, uidnext } }` in the token; if the snapshot changes, return a warning and proceed best-effort.

## 9) Security & Privacy

Non-negotiables:

- Never include passwords, OAuth tokens, cookies, or other credentials in tool outputs.
- Scrub secrets from audit logs (redact keys like `password`, `token`, `secret`, `authorization`, etc.).
- Gate write operations behind explicit configuration (e.g., “read-only mode” default).
- Destructive actions (`delete`) must require `confirm: true`.

IMAP-specific considerations:

- Prefer app passwords / OAuth flows managed outside the LLM prompt; avoid passing credentials as tool arguments.
- Enforce size limits on fetched bodies/attachments and require explicit opt-in for larger payloads.
- Treat HTML as untrusted input:
  - sanitize HTML before returning it
  - prefer returning text extracts (snippets) by default

## 10) Observability & Operations

- Structured logs for each tool invocation (tool name, duration, success/failure).
- Audit log (scrubbed args) for every tool call.
- Optional health surface (transport-dependent) that reports version and basic status without secrets.
- Optional rate limiting / quotas if exposed beyond a single-user local environment.

## 11) Error Handling

- Return specific, user-actionable errors:
  - Invalid mailbox name, auth failures, network timeouts, message not found, unsupported charset, etc.
- Avoid generic “500” responses; include enough context to remediate without leaking sensitive data.

## 12) Testing Strategy

Minimum coverage per tool:

- Valid input → expected result shape and summary text.
- Invalid input (schema violations) → `isError: true` with actionable message.
- Pagination stability across pages (no duplicates/omissions for a stable mailbox snapshot).
- Token efficiency checks (responses remain concise under configured thresholds).
- Confirmation enforcement (delete rejects missing/false `confirm`).

Implementation notes for this stack:

- Use **Vitest** for unit/integration tests and run `tsc --noEmit` in CI.
- Validate tool inputs and outputs with Zod in tests (and at runtime where helpful).

## 13) Versioning & Compatibility

- Use semantic versioning `MAJOR.MINOR.PATCH`.
- Backward compatibility rules:
  - Tool names and required fields are the contract.
  - Deprecate before removal; document migrations for schema changes.
