import type { ToolName } from './contracts.js';

export const WRITE_TOOLS = new Set<ToolName>([
  'imap_update_message_flags',
  'imap_copy_message',
  'imap_move_message',
  'imap_delete_message',
]);
