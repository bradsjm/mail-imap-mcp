import type { MessageIdParts } from '../message-id.js';
import { decodeMessageId } from '../message-id.js';

export type MessageIdLookupResult = Readonly<{ decoded: MessageIdParts } | { error: string }>;

/**
 * Decode a message_id and ensure it matches the requested account.
 */
export function decodeMessageIdOrError(
  messageId: string,
  accountId: string,
): MessageIdLookupResult {
  const decoded = decodeMessageId(messageId);
  if (!decoded) {
    return {
      error: "Invalid message_id. Expected 'imap:{account_id}:{mailbox}:{uidvalidity}:{uid}'.",
    };
  }
  if (decoded.account_id !== accountId) {
    return { error: 'message_id does not match the requested account_id.' };
  }
  return { decoded };
}
