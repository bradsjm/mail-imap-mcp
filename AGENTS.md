# Repository Guidelines

This repository contains a TypeScript MCP (stdio) server for IMAP email access. Follow the conventions
below to keep changes consistent, testable, and easy to review.

## Project Structure & Module Organization

- `src/` contains the server entry point and core logic.
- `tests*/*.test.ts` contains Vitest unit tests.
- `dist/` is the build output (generated).
- `docs/` holds supplementary documentation.

## Build, Test, and Development Commands

- `pnpm install` — install dependencies.
- `pnpm dev` — run the server locally via `tsx`.
- `pnpm build` — compile TypeScript into `dist/`.
- `pnpm check` — run formatting, linting, type checks, and tests.
- `pnpm test` — run Vitest in CI mode.

## Configuration & Secrets

This skeleton supports a single `account_id` of `default`. Configure via environment variables:

- `MAIL_IMAP_DEFAULT_HOST`
- `MAIL_IMAP_DEFAULT_PORT` (default `993`)
- `MAIL_IMAP_DEFAULT_SECURE` (default `true`)
- `MAIL_IMAP_DEFAULT_USER`
- `MAIL_IMAP_DEFAULT_PASS`

Avoid committing secrets or `.env` files. Use local environment configuration instead.

## Coding Style & Naming Conventions

- TypeScript strict mode is enabled; prefer explicit types and avoid `any`.
- Use ES module syntax and keep files in `src/`.
- Format with Prettier and lint with ESLint:
  - `pnpm format:check`
  - `pnpm lint`
- Test files should end with `.test.ts`.

## Testing Guidelines

- Tests use Vitest (`vitest.config.ts`).
- Name tests descriptively and cover core tool behavior and edge cases.
- Run tests with `pnpm test` or the full suite with `pnpm check`.

## Commit & Pull Request Guidelines

No repository-specific commit convention is enforced here. Use clear, imperative commit subjects
(e.g., “Add IMAP mailbox listing filter”) and keep commits scoped.

For PRs, include:

- A concise description of changes and rationale.
- Linked issues or tickets when applicable.
- Notes on configuration changes (new env vars, defaults, or security impacts).
