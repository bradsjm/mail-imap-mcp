import { z } from 'zod';

import {
  TOOL_DEFINITIONS,
  type ToolDefinition,
  type ToolName,
  DeleteMessageInputSchema,
  GetMessageInputSchema,
  GetMessageRawInputSchema,
  ListAccountsInputSchema,
  ListMailboxesInputSchema,
  MoveMessageInputSchema,
  SearchMessagesInputSchema,
  UpdateMessageFlagsInputSchema,
  VerifyAccountInputSchema,
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
import { handleListAccounts } from './tools/list_accounts.js';
import { handleListMailboxes } from './tools/list_mailboxes.js';
import { handleMoveMessage } from './tools/move_message.js';
import { handleSearchMessages } from './tools/search_messages.js';
import { handleUpdateMessageFlags } from './tools/update_message_flags.js';
import { handleVerifyAccount } from './tools/verify_account.js';
import { scrubSecrets } from './logging.js';
import { getAvailableTools } from './utils/tools.js';

const TOOL_INPUT_SCHEMAS: Readonly<Record<ToolName, z.ZodTypeAny>> = {
  imap_list_accounts: ListAccountsInputSchema,
  imap_list_mailboxes: ListMailboxesInputSchema,
  imap_search_messages: SearchMessagesInputSchema,
  imap_get_message: GetMessageInputSchema,
  imap_get_message_raw: GetMessageRawInputSchema,
  imap_update_message_flags: UpdateMessageFlagsInputSchema,
  imap_move_message: MoveMessageInputSchema,
  imap_delete_message: DeleteMessageInputSchema,
  imap_verify_account: VerifyAccountInputSchema,
};

/**
 * Get the list of available MCP tools in the format required by the MCP protocol.
 *
 * Filters tool definitions based on write-enable policy and converts them
 * to the format expected by the Model Context Protocol server. This includes
 * the tool name, description, and JSON Schema for input validation.
 *
 * @returns Array of tool definitions compatible with the MCP protocol
 */
export function getListedTools(): Array<{
  name: ToolName;
  description: string;
  inputSchema: unknown;
}> {
  const available: readonly ToolDefinition[] = getAvailableTools(TOOL_DEFINITIONS);

  return available.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
  }));
}

/**
 * Handle an incoming MCP tool call request.
 *
 * This is the main entry point for all tool operations. It performs the following steps:
 * 1. Validates that the tool exists and is registered
 * 2. Parses and validates input arguments using Zod schemas
 * 3. Checks write-operation permissions if applicable
 * 4. Routes to the appropriate handler function
 * 5. Captures and maps any IMAP errors to user-friendly messages
 * 6. Logs telemetry for monitoring and debugging
 *
 * @param toolName - The name of the tool being called
 * @param rawArgs - The raw arguments object to be validated and passed to the handler
 * @returns A ToolResult containing either the successful operation data or an error message
 */
export async function handleToolCall(toolName: ToolName, rawArgs: unknown): Promise<ToolResult> {
  const startedAtNs = process.hrtime.bigint();
  let errorForLog: unknown;

  try {
    // Find the tool definition - if not found, the tool is not registered
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === toolName);
    if (!tool) {
      return makeError(`Unknown tool: '${toolName}'.`);
    }

    // Validate input arguments using the Zod schema
    // This provides type safety and user-friendly error messages
    const schema = TOOL_INPUT_SCHEMAS[toolName];
    const parsedArgs = schema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      return makeError(`Invalid input:\n${formatZodError(parsedArgs.error)}`);
    }

    // Check write permissions for write operations (move, delete, flag updates)
    // This provides an additional layer of safety to prevent accidental modifications
    if (WRITE_TOOLS.has(toolName) && !WRITE_ENABLED) {
      return makeError(
        'Write operations are disabled. Set MAIL_IMAP_WRITE_ENABLED=true to enable updates.',
      );
    }

    switch (toolName) {
      case 'imap_list_accounts':
        return handleListAccounts(ListAccountsInputSchema.parse(rawArgs));
      case 'imap_list_mailboxes':
        return await handleListMailboxes(ListMailboxesInputSchema.parse(rawArgs));
      case 'imap_search_messages':
        return await handleSearchMessages(SearchMessagesInputSchema.parse(rawArgs));
      case 'imap_get_message':
        return await handleGetMessage(GetMessageInputSchema.parse(rawArgs));
      case 'imap_update_message_flags':
        return await handleUpdateMessageFlags(UpdateMessageFlagsInputSchema.parse(rawArgs));
      case 'imap_move_message':
        return await handleMoveMessage(MoveMessageInputSchema.parse(rawArgs));
      case 'imap_delete_message':
        return await handleDeleteMessage(DeleteMessageInputSchema.parse(rawArgs));
      case 'imap_get_message_raw':
        return await handleGetMessageRaw(GetMessageRawInputSchema.parse(rawArgs));
      case 'imap_verify_account':
        return await handleVerifyAccount(VerifyAccountInputSchema.parse(rawArgs));
      default:
        // This should never happen if TOOL_DEFINITIONS is kept in sync with handlers
        return makeError(`Tool '${String(toolName)}' is registered but not implemented yet.`);
    }
  } catch (error: unknown) {
    // Capture the error for logging, then map it to a user-friendly message
    // IMAP errors are often technical and need translation for end users
    errorForLog = error;
    const mapped = mapImapError(error);
    return makeError(mapped.message, [], mapped.meta);
  } finally {
    // Log telemetry for monitoring and debugging
    // We use stderr for structured logging (JSON) and stdout for MCP protocol communication
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
