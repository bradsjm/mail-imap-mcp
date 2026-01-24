import type { ToolName } from './contracts.js';

export const WRITE_TOOLS = new Set<ToolName>([
  'mail_imap_update_message_flags',
  'mail_imap_move_message',
  'mail_imap_delete_message',
]);
