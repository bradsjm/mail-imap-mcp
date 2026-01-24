import { z } from 'zod';

import {
  TOOL_DEFINITIONS,
  type ToolDefinition,
  type ToolName,
  DeleteMessageInputSchema,
  GetMessageInputSchema,
  GetMessageRawInputSchema,
  ListMailboxesInputSchema,
  MoveMessageInputSchema,
  SearchMessagesInputSchema,
  UpdateMessageFlagsInputSchema,
} from './contracts.js';
import { WRITE_ENABLED } from './config.js';
import { WRITE_TOOLS } from './policy.js';
import {
  formatZodError,
  makeError,
  mapImapError,
  toErrorLog,
  type ToolResult,
} from './tools/runtime.js';
import { handleDeleteMessage } from './tools/delete_message.js';
import { handleGetMessage } from './tools/get_message.js';
import { handleGetMessageRaw } from './tools/get_message_raw.js';
import { handleListMailboxes } from './tools/list_mailboxes.js';
import { handleMoveMessage } from './tools/move_message.js';
import { handleSearchMessages } from './tools/search_messages.js';
import { handleUpdateMessageFlags } from './tools/update_message_flags.js';
import { scrubSecrets } from './logging.js';

const TOOL_INPUT_SCHEMAS: Readonly<Record<ToolName, z.ZodTypeAny>> = {
  mail_imap_list_mailboxes: ListMailboxesInputSchema,
  mail_imap_search_messages: SearchMessagesInputSchema,
  mail_imap_get_message: GetMessageInputSchema,
  mail_imap_get_message_raw: GetMessageRawInputSchema,
  mail_imap_update_message_flags: UpdateMessageFlagsInputSchema,
  mail_imap_move_message: MoveMessageInputSchema,
  mail_imap_delete_message: DeleteMessageInputSchema,
};

export function getListedTools(): Array<{
  name: ToolName;
  description: string;
  inputSchema: unknown;
}> {
  const available: readonly ToolDefinition[] = TOOL_DEFINITIONS.filter((tool) => {
    if (WRITE_ENABLED) {
      return true;
    }
    return !WRITE_TOOLS.has(tool.name);
  });

  return available.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
  }));
}

export async function handleToolCall(toolName: ToolName, rawArgs: unknown): Promise<ToolResult> {
  const startedAtNs = process.hrtime.bigint();
  let errorForLog: unknown;

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

    switch (toolName) {
      case 'mail_imap_list_mailboxes':
        return await handleListMailboxes(ListMailboxesInputSchema.parse(rawArgs));
      case 'mail_imap_search_messages':
        return await handleSearchMessages(SearchMessagesInputSchema.parse(rawArgs));
      case 'mail_imap_get_message':
        return await handleGetMessage(GetMessageInputSchema.parse(rawArgs));
      case 'mail_imap_update_message_flags':
        return await handleUpdateMessageFlags(UpdateMessageFlagsInputSchema.parse(rawArgs));
      case 'mail_imap_move_message':
        return await handleMoveMessage(MoveMessageInputSchema.parse(rawArgs));
      case 'mail_imap_delete_message':
        return await handleDeleteMessage(DeleteMessageInputSchema.parse(rawArgs));
      case 'mail_imap_get_message_raw':
        return await handleGetMessageRaw(GetMessageRawInputSchema.parse(rawArgs));
      default:
        return makeError(`Tool '${String(toolName)}' is registered but not implemented yet.`);
    }
  } catch (error: unknown) {
    errorForLog = error;
    const mapped = mapImapError(error);
    return makeError(mapped.message, [], mapped.meta);
  } finally {
    const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
    console.error(
      JSON.stringify({
        level: 'info',
        event: 'tool_call',
        tool: toolName,
        duration_ms: Math.round(durationMs),
        arguments: scrubSecrets(rawArgs),
        error: toErrorLog(errorForLog),
      }),
    );
  }
}
