import { ImapFlow } from 'imapflow';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ZodError } from 'zod';
import { fileURLToPath } from 'node:url';
import {
  TOOL_DEFINITIONS,
  type ToolName,
  DeleteMessageInputSchema,
  GetMessageInputSchema,
  GetMessageRawInputSchema,
  ListMailboxesInputSchema,
  MoveMessageInputSchema,
  SearchMessagesInputSchema,
  UpdateMessageFlagsInputSchema,
} from './contracts.js';

type AccountConfig = Readonly<{
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}>;

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseNumberEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizeEnvSegment(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

export function scrubSecrets(value: unknown): unknown {
  const secretKeyPattern = /(pass(word)?|token|secret|authorization|cookie|key)/i;

  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item));
  }

  if (value && typeof value === 'object') {
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      record[k] = secretKeyPattern.test(k) ? '[REDACTED]' : scrubSecrets(v);
    }
    return record;
  }

  return value;
}

function loadAccountConfig(accountId: string): AccountConfig | null {
  const prefix = `MAIL_IMAP_${normalizeEnvSegment(accountId)}_`;

  const host = process.env[`${prefix}HOST`];
  const user = process.env[`${prefix}USER`];
  const pass = process.env[`${prefix}PASS`];

  if (!host || !user || !pass) {
    return null;
  }

  const port = parseNumberEnv(process.env[`${prefix}PORT`], 993);
  const secure = parseBooleanEnv(process.env[`${prefix}SECURE`], true);

  return { host, port, secure, user, pass };
}

async function withImapClient<T>(
  account: AccountConfig,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: {
      user: account.user,
      pass: account.pass,
    },
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function makeError(text: string): { isError: true; content: [{ type: 'text'; text: string }] } {
  return { isError: true, content: [{ type: 'text', text }] };
}

function makeOk(text: string): { isError: false; content: [{ type: 'text'; text: string }] } {
  return { isError: false, content: [{ type: 'text', text }] };
}

const WRITE_ENABLED = parseBooleanEnv(process.env['MAIL_IMAP_WRITE_ENABLED'], false);

const TOOL_INPUT_SCHEMAS: Readonly<Record<ToolName, z.ZodTypeAny>> = {
  mail_imap_list_mailboxes: ListMailboxesInputSchema,
  mail_imap_search_messages: SearchMessagesInputSchema,
  mail_imap_get_message: GetMessageInputSchema,
  mail_imap_get_message_raw: GetMessageRawInputSchema,
  mail_imap_update_message_flags: UpdateMessageFlagsInputSchema,
  mail_imap_move_message: MoveMessageInputSchema,
  mail_imap_delete_message: DeleteMessageInputSchema,
};

const WRITE_TOOLS = new Set<ToolName>([
  'mail_imap_update_message_flags',
  'mail_imap_move_message',
  'mail_imap_delete_message',
]);

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
      return `${path}: ${issue.message}`;
    })
    .join('\n');
}

export function createServer(): Server {
  const server = new Server(
    { name: 'mail-imap-mcp', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startedAtNs = process.hrtime.bigint();

    const toolName = request.params.name as ToolName;
    const rawArgs = request.params.arguments;

    try {
      const tool = TOOL_DEFINITIONS.find((definition) => definition.name === toolName);
      if (!tool) {
        return makeError(`Unknown tool: '${toolName}'.`);
      }

      const schema = TOOL_INPUT_SCHEMAS[toolName];
      const parsedArgs = schema.safeParse(rawArgs);
      if (!parsedArgs.success) {
        return makeError(`Invalid input:\n${formatZodError(parsedArgs.error)}`);
      }

      if (WRITE_TOOLS.has(toolName) && !WRITE_ENABLED) {
        return makeError(
          'Write operations are disabled. Set MAIL_IMAP_WRITE_ENABLED=true to enable updates.',
        );
      }

      if (toolName === 'mail_imap_list_mailboxes') {
        const args = ListMailboxesInputSchema.parse(rawArgs);
        const account = loadAccountConfig(args.account_id);
        if (!account) {
          const prefix = `MAIL_IMAP_${normalizeEnvSegment(args.account_id)}_`;
          return makeError(
            [
              `Account '${args.account_id}' is not configured.`,
              `Set env vars:`,
              `- ${prefix}HOST`,
              `- ${prefix}USER`,
              `- ${prefix}PASS`,
              `Optional: ${prefix}PORT (default 993), ${prefix}SECURE (default true)`,
            ].join('\n'),
          );
        }

        const mailboxes = await withImapClient(account, (client) => client.list());
        const paths = mailboxes
          .map((m) => m.path)
          .filter((p): p is string => typeof p === 'string');
        const preview = paths
          .slice(0, 30)
          .map((p) => `- ${p}`)
          .join('\n');
        const suffix = paths.length > 30 ? `\n… and ${paths.length - 30} more` : '';

        return makeOk(`Mailboxes (${paths.length}):\n${preview}${suffix}`);
      }

      return makeError(`Tool '${toolName}' is registered but not implemented yet.`);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
      console.error(
        JSON.stringify({
          level: 'info',
          event: 'tool_call',
          tool: toolName,
          duration_ms: Math.round(durationMs),
          arguments: scrubSecrets(rawArgs),
        }),
      );
    }
  });

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mail-imap-mcp running on stdio');
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === entry;
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Fatal error: ${message}`);
    process.exitCode = 1;
  });
}
