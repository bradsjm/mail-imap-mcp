# mail-imap-mcp

A TypeScript MCP (stdio) server that provides secure, outcome-oriented tools for searching, reading, and modifying email over IMAP. Designed for integration with AI agents and code assistants through the Model Context Protocol.

## Quick Start

The fastest way to run this server is via `npx`:

```bash
npx -y @bradsjm/mail-imap-mcp
```

Before running, you'll need to configure your IMAP account credentials via environment variables (see Configuration below).

## Transport & Security

This server uses **stdio transport only** for security reasons. There is no built-in HTTP transport support. The server communicates through standard input/output, making it ideal for:

- Local development with AI coding assistants
- Secure integrations where HTTP exposure is undesirable
- Containerized or sandboxed environments

```
┌─────────────────┐         stdio         ┌──────────────────────┐
│  MCP Client     │ ◄───────────────────► │  mail-imap-mcp       │
│  (AI Agent)     │    JSON-RPC messages  │  (stdio Server)      │
└─────────────────┘                       └──────────────────────┘
                                                  │
                                                  ▼
                                        ┌──────────────────────┐
                                        │  IMAP Email Server   │
                                        │  (Gmail, Outlook,    │
                                        │   self-hosted, etc.) │
                                        └──────────────────────┘
```

## Configuration

Configure your IMAP accounts through environment variables. The server loads these directly and does not support configuration files.

### Account Configuration

| Environment Variable       | Required | Default | Description                                   |
| -------------------------- | -------- | ------- | --------------------------------------------- |
| `MAIL_IMAP_DEFAULT_HOST`   | Yes      | -       | IMAP server hostname (e.g., `imap.gmail.com`) |
| `MAIL_IMAP_DEFAULT_PORT`   | No       | `993`   | IMAP server port                              |
| `MAIL_IMAP_DEFAULT_SECURE` | No       | `true`  | Use TLS/SSL for connection                    |
| `MAIL_IMAP_DEFAULT_USER`   | Yes      | -       | IMAP username or email address                |
| `MAIL_IMAP_DEFAULT_PASS`   | Yes      | -       | IMAP password or app-specific token           |

### Multiple Accounts

You can configure multiple accounts by replacing `DEFAULT` with your account identifier (uppercase):

```bash
# Default account
MAIL_IMAP_DEFAULT_HOST=imap.gmail.com
MAIL_IMAP_DEFAULT_USER=john@gmail.com
MAIL_IMAP_DEFAULT_PASS=app-password-here

# Work account
MAIL_IMAP_WORK_HOST=imap.outlook.com
MAIL_IMAP_WORK_USER=john@company.com
MAIL_IMAP_WORK_PASS=work-password-here
```

### Server Settings

| Environment Variable            | Required | Default  | Description                                          |
| ------------------------------- | -------- | -------- | ---------------------------------------------------- |
| `MAIL_IMAP_WRITE_ENABLED`       | No       | `false`  | Enable write operations (move, delete, flag updates) |
| `MAIL_IMAP_CONNECT_TIMEOUT_MS`  | No       | `30000`  | Connection timeout in milliseconds                   |
| `MAIL_IMAP_GREETING_TIMEOUT_MS` | No       | `15000`  | IMAP server greeting timeout in milliseconds         |
| `MAIL_IMAP_SOCKET_TIMEOUT_MS`   | No       | `300000` | Socket activity timeout in milliseconds              |

### Example MCP Client Configuration

```json
{
  "command": "npx",
  "args": ["-y", "@bradsjm/mail-imap-mcp"],
  "env": {
    "MAIL_IMAP_DEFAULT_HOST": "imap.gmail.com",
    "MAIL_IMAP_DEFAULT_USER": "your-email@gmail.com",
    "MAIL_IMAP_DEFAULT_PASS": "your-app-password"
  }
}
```

## Available Tools

The server provides the following MCP tools:

| Tool Name                   | Description                                 | Write Access |
| --------------------------- | ------------------------------------------- | ------------ |
| `imap_list_mailboxes`       | List available mailboxes for an account     | No           |
| `imap_search_messages`      | Search messages with filters and pagination | No           |
| `imap_get_message`          | Fetch message headers and body text         | No           |
| `imap_get_message_raw`      | Fetch raw RFC822 message source             | No           |
| `imap_update_message_flags` | Update message flags (read/unread, etc.)    | Yes          |
| `imap_move_message`         | Move message to another mailbox             | Yes          |
| `imap_delete_message`       | Delete a message (requires confirmation)    | Yes          |

## Resources (Optional)

Some MCP clients can browse/read server-provided Resources (`resources/list`, `resources/read`). This
server exposes additional read-only resources for messages and attachments. Tool-only clients remain
fully supported.

Resource URI templates:

- Message (parsed/sanitized): `imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}`
- Message raw (RFC822, truncated): `imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}/raw`
- Attachment bytes (base64 blob, size-capped): `imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}/attachment/{part_id}`
- Attachment text (text/\* + PDF only, bounded): `imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}/attachment/{part_id}/text`

To bridge tools and resources, some tool outputs include optional `message_uri`, `message_raw_uri`,
`attachment_uri`, and `attachment_text_uri` fields so resource-capable clients can attach the relevant
resource directly.

### Tool Details

#### `imap_list_mailboxes`

Discovers available mailboxes (folders) for an IMAP account.

**Parameters:**

- `account_id` (optional, default: "default") - Account identifier

**Example Response:**

```json
{
  "summary": "Found 5 mailboxes",
  "data": {
    "mailboxes": ["INBOX", "Sent", "Drafts", "Archive", "Spam"]
  }
}
```

#### `imap_search_messages`

Searches for messages in a mailbox with flexible filtering and pagination.

**Parameters:**

- `account_id` (optional, default: "default") - Account identifier
- `mailbox` (optional, default: "INBOX") - Mailbox to search
- `query` (optional) - Full-text search query
- `from` (optional) - Filter by sender
- `to` (optional) - Filter by recipient
- `subject` (optional) - Filter by subject line
- `unread_only` (optional) - Only show unread messages
- `last_days` (optional) - Search messages from last N days
- `start_date` (optional) - Search from this date (ISO 8601)
- `end_date` (optional) - Search until this date (ISO 8601)
- `limit` (optional, default: 10) - Maximum results per page
- `page_token` (optional) - Pagination token from previous search

**Example Response:**

```json
{
  "summary": "Found 37 messages in INBOX. Showing 10 starting at 1.",
  "data": {
    "account_id": "default",
    "mailbox": "INBOX",
    "total": 37,
    "messages": [
      {
        "message_id": "imap:default:INBOX:123:456",
        "date": "2026-01-22T10:01:00.000Z",
        "from": "Alice <alice@example.com>",
        "subject": "Weekly update",
        "flags": ["\\Seen"]
      }
    ],
    "next_page_token": "..."
  }
}
```

#### `imap_get_message`

Retrieves a single message with headers and bounded text content. Optionally extracts text from PDF attachments.

**Parameters:**

- `account_id` (optional, default: "default") - Account identifier
- `message_id` (required) - Stable message identifier
- `body_max_chars` (optional, default: 2000, max: 20000) - Maximum characters for message body
- `include_headers` (optional, default: true) - Include common headers
- `include_all_headers` (optional, default: false) - Include all headers
- `include_html` (optional, default: false) - Include HTML content (sanitized)
- `extract_attachment_text` (optional, default: false) - Extract text from PDFs
- `attachment_text_max_chars` (optional, default: 10000, max: 50000) - Max chars per PDF

**PDF Extraction Notes:**

- Only processes PDFs up to 5MB
- Extraction failures are logged but don't fail the request
- Can significantly increase response time

#### `imap_get_message_raw`

Fetches the raw RFC822 message source. Size-limited for security.

**Parameters:**

- `account_id` (optional, default: "default") - Account identifier
- `message_id` (required) - Stable message identifier
- `max_bytes` (optional, default: 1048576) - Maximum bytes to return

#### `imap_update_message_flags`

Adds or removes flags on a message (e.g., mark as read/unread). Requires `MAIL_IMAP_WRITE_ENABLED=true`.

**Parameters:**

- `account_id` (optional, default: "default") - Account identifier
- `message_id` (required) - Stable message identifier
- `add_flags` (optional) - Flags to add (e.g., `["\\Seen"]`)
- `remove_flags` (optional) - Flags to remove

#### `imap_move_message`

Moves a message to another mailbox. Uses IMAP MOVE if supported, otherwise COPY+DELETE. Requires `MAIL_IMAP_WRITE_ENABLED=true`.

**Parameters:**

- `account_id` (optional, default: "default") - Account identifier
- `message_id` (required) - Stable message identifier
- `target_mailbox` (required) - Destination mailbox name

#### `imap_delete_message`

Deletes a message permanently. Requires explicit confirmation and `MAIL_IMAP_WRITE_ENABLED=true`.

**Parameters:**

- `account_id` (optional, default: "default") - Account identifier
- `message_id` (required) - Stable message identifier
- `confirm` (required) - Must be `true` to proceed

## Message Identity

Messages are identified by a stable, self-describing identifier format:

```
imap:{account_id}:{mailbox}:{uidvalidity}:{uid}
```

**Example:**

```
imap:default:INBOX:123456789:98765
```

**Breakdown:**

```
┌─── Protocol ───┬──── Account ────┬── Mailbox ───┬─ UIDVALIDITY ─┬─ UID ─┐
|     imap:      |     default:    |    INBOX:    |   123456789:  | 98765 |
└────────────────┴─────────────────┴──────────────┴───────────────┴───────┘
```

The server validates this format and rejects mismatches. The `uidvalidity` and `uid` components ensure stable references even after mailbox changes.

## Response Format

All tool responses follow a consistent JSON structure:

```json
{
  "summary": "Concise human-readable summary of what happened",
  "data": {
    // Structured result data (tool-specific)
  },
  "hints": [
    {
      "tool": "imap_get_message",
      "arguments": { "message_id": "imap:default:INBOX:123:456" },
      "reason": "Fetch full details for this message"
    }
  ],
  "_meta": {
    "now_utc": "2026-01-23T12:34:56.789Z",
    "operation_duration_ms": 234
  }
}
```

- `summary`: Brief description for human readers
- `data`: Tool-specific result data
- `hints`: Suggested next tool calls with pre-populated arguments
- `_meta`: Metadata about the operation (timing, etc.)

## Pagination

The `imap_search_messages` tool supports pagination through an opaque `next_page_token`:

```
┌──────────────┐
│ First Search │
│ (no token)   │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Page 1     │
│ + next_token │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Page 2     │
│ + next_token │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Page 3     │
│ (no token)   │  ← Last page
└──────────────┘
```

Tokens are stored in-memory with a short TTL. If a token expires or the mailbox UIDVALIDITY changes, you must re-run the search.

## Development

For local development:

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build for production
pnpm build

# Run full checks (format, lint, typecheck, tests)
pnpm check

# Run tests only
pnpm test
```

The project uses TypeScript with strict mode, Vitest for testing, Prettier for formatting, and ESLint for linting.

## Security Notes

- **No HTTP transport**: This server intentionally does not include HTTP transport support for security reasons
- **Credential management**: Never commit credentials or `.env` files. Use environment variables or secret management systems
- **Write operations**: Disabled by default; explicitly enable with `MAIL_IMAP_WRITE_ENABLED=true`
- **Size limits**: All data retrieval operations have size limits to prevent memory issues
- **Secret logging**: Audit logs automatically scrub secret-like fields from arguments
- **HTML sanitization**: All HTML content is sanitized before being returned

## License

MIT
