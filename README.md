# mail-imap-mcp

TypeScript MCP (stdio) server for email access via IMAP.

## Dev

- Install: `pnpm install`
- Run: `pnpm dev`
- Build: `pnpm build`
- Checks: `pnpm check`

Note: This repo whitelists `esbuild` build scripts via `package.json` (`pnpm.onlyBuiltDependencies`) so `tsx`/`vitest` work on pnpm installs that require build approvals.

## Configuration (temporary skeleton)

This skeleton supports a single `account_id` of `default` using environment variables:

- `MAIL_IMAP_DEFAULT_HOST`
- `MAIL_IMAP_DEFAULT_PORT` (default `993`)
- `MAIL_IMAP_DEFAULT_SECURE` (default `true`)
- `MAIL_IMAP_DEFAULT_USER`
- `MAIL_IMAP_DEFAULT_PASS`

## Tools (current skeleton)

- `mail_imap_list_mailboxes` (implemented)
- Others are registered but return “not implemented” for now.
