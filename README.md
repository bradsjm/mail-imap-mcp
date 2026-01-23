# mail-imap-mcp

TypeScript MCP (stdio) server for IMAP email access with a compact, LLM-optimized tool surface.

## Overview

This server exposes outcome-oriented tools to search, read, and safely modify mailboxes over IMAP.
Responses are JSON-encoded text and include:

- `summary`: concise human-readable summary
- `data`: structured payload aligned to the tool contract
- `hints`: suggested next tool calls with minimal arguments
- `_meta`: optional metadata (e.g., `now_utc`, pagination, capabilities)

## Capabilities

### Read

- List mailboxes
- Search messages with filters and pagination
- Fetch a message body/headers with size limits
- Fetch raw RFC822 source (size-limited)
- Attachment metadata discovery (no bytes by default)

### Write (gated)

- Update message flags
- Move messages (MOVE when supported, otherwise COPY+DELETE)
- Delete messages (requires confirmation)

## Tools

### `mail_imap_list_mailboxes`

List mailboxes for a configured account.

### `mail_imap_search_messages`

Search messages in a mailbox with filters and pagination.

Inputs include:

- `account_id`, `mailbox`
- `last_days` (integer, optional; search recent messages without providing explicit dates)
- `query`, `from`, `to`, `subject`
- `unread_only`, `start_date`, `end_date` (do not combine with `last_days`)
- `limit`, `page_token`

### `mail_imap_get_message`

Fetch a single message by `message_id` and return headers + bounded text/HTML snippets.

### `mail_imap_get_message_raw`

Fetch raw RFC822 source (size-limited by `max_bytes`).

### `mail_imap_update_message_flags`

Add or remove flags on a message (write-gated).

### `mail_imap_move_message`

Move a message to another mailbox. Uses MOVE if supported; otherwise COPY+DELETE.

### `mail_imap_delete_message`

Delete a message (write-gated; requires `confirm: true`).

## Message identity

Messages are identified by a stable `message_id`:

```
imap:{account_id}:{mailbox}:{uidvalidity}:{uid}
```

The server validates this format and rejects mismatches.

## Pagination

`mail_imap_search_messages` returns an opaque `next_page_token`.
Tokens are stored in-memory with a short TTL for stability. If a token expires or the mailbox UIDVALIDITY changes, you must re-run the search.

## Configuration

Account configuration is provided via environment variables:

This server also loads a local `.env` file (if present) using `dotenv`. Do not commit secrets.
An example is provided in `.env.sample`.

If you only configure the `default` account, you can omit `account_id` in tool calls; it defaults to `default`.

```
MAIL_IMAP_DEFAULT_HOST
MAIL_IMAP_DEFAULT_PORT=993
MAIL_IMAP_DEFAULT_SECURE=true
MAIL_IMAP_DEFAULT_USER
MAIL_IMAP_DEFAULT_PASS
```

Multiple accounts are supported by replacing `DEFAULT` with an uppercase account ID:

```
MAIL_IMAP_WORK_HOST
MAIL_IMAP_WORK_USER
MAIL_IMAP_WORK_PASS
```

### Write operations

Writes are disabled by default. Enable with:

```
MAIL_IMAP_WRITE_ENABLED=true
```

### Timeouts

```
MAIL_IMAP_CONNECT_TIMEOUT_MS=30000
MAIL_IMAP_GREETING_TIMEOUT_MS=15000
MAIL_IMAP_SOCKET_TIMEOUT_MS=300000
```

## Response shape (JSON text)

Many MCP clients expect `content` items to be `type: "text"` (and do not accept a JSON content type).
This server returns a single `text` content item whose text is a JSON object:

```
{
  "summary": "Found 37 messages in INBOX. Showing 10 starting at 1.",
  "data": {
    "account_id": "default",
    "mailbox": "INBOX",
    "total": 37,
    "messages": [
      {
        "message_id": "imap:default:INBOX:123:456",
        "mailbox": "INBOX",
        "uidvalidity": 123,
        "uid": 456,
        "date": "2026-01-22T10:01:00.000Z",
        "from": "Alice <alice@example.com>",
        "subject": "Weekly update",
        "flags": ["\\Seen"]
      }
    ],
    "next_page_token": "..."
  },
  "hints": [
    {
      "tool": "mail_imap_get_message",
      "arguments": { "account_id": "default", "message_id": "imap:default:INBOX:123:456" },
      "reason": "Fetch full details for the first message."
    }
  ],
  "_meta": { "now_utc": "2026-01-23T12:34:56.789Z", "next_page_token": "..." }
}
```

## Usage

### Run locally

```
pnpm install
pnpm dev
```

### Build

```
pnpm build
```

## Chat Application Integration (stdio spawn command)

Many MCP-enabled chat applications run stdio servers by spawning a process from an executable command.
These are common ways to invoke this server:

### Option 1: Run via npx (published package)

- `command`: `npx`
- `args`: `-y @bradsjm/mail-imap-mcp`

### Option 2: Run from this repo (dev, no build)

- `command`: `pnpm`
- `args`: `-C /Users/jonathan/Code/Projects/mail-imap-mcp dev`

### Option 3: Run from this repo (built)

1. Build once:

   ```
   pnpm -C /Users/jonathan/Code/Projects/mail-imap-mcp build
   ```

2. Spawn:

- `command`: `node`
- `args`: `/Users/jonathan/Code/Projects/mail-imap-mcp/dist/index.js`

### Option 4: Install globally (true executable)

1. Install:

   ```
   pnpm -g add /Users/jonathan/Code/Projects/mail-imap-mcp
   ```

2. Spawn:

- `command`: `mail-imap-mcp`

### Example MCP server config

Exact configuration keys vary by chat application, but the shape usually looks like:

```json
{
  "command": "node",
  "args": ["mail-imap-mcp/dist/index.js"],
  "env": {
    "MAIL_IMAP_DEFAULT_HOST": "imap.example.com",
    "MAIL_IMAP_DEFAULT_USER": "me@example.com",
    "MAIL_IMAP_DEFAULT_PASS": "app-password-or-token"
  }
}
```

### Quality gates

```
pnpm check
```

## Notes

- HTML content is sanitized before returning.
- Raw message retrieval is size-limited.
- Move uses MOVE if supported; otherwise COPY+DELETE.
- Audit logs scrub secret-like fields from arguments.

## Development

This repo whitelists `esbuild` build scripts via `package.json` (`pnpm.onlyBuiltDependencies`) so `tsx`/`vitest` work on pnpm installs that require build approvals.
