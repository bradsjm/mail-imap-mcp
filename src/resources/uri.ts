/**
 * Helpers for building and parsing stable MCP resource URIs.
 *
 * These URIs are intentionally independent of tool inputs so that:
 * - Tools remain backward-compatible for clients that don't support resources.
 * - Resources can be referenced/attached by clients that do support resources.
 *
 * Mailbox names are encoded as a single URL path segment because IMAP mailbox names
 * may contain delimiter characters like "/".
 */

export type MessageLocator = Readonly<{
  account_id: string;
  mailbox: string;
  uidvalidity: number;
  uid: number;
}>;

export type AttachmentLocator = MessageLocator &
  Readonly<{
    part_id: string;
  }>;

export function encodeMailboxSegment(mailbox: string): string {
  return encodeURIComponent(mailbox);
}

export function decodeMailboxSegment(segment: string): string {
  return decodeURIComponent(segment);
}

export function messageResourceUri(locator: MessageLocator): string {
  return `imap://${locator.account_id}/mailbox/${encodeMailboxSegment(locator.mailbox)}/message/${locator.uidvalidity}/${locator.uid}`;
}

export function messageRawResourceUri(locator: MessageLocator): string {
  return `${messageResourceUri(locator)}/raw`;
}

export function attachmentResourceUri(locator: AttachmentLocator): string {
  return `${messageResourceUri(locator)}/attachment/${encodeURIComponent(locator.part_id)}`;
}

export function attachmentTextResourceUri(locator: AttachmentLocator): string {
  return `${attachmentResourceUri(locator)}/text`;
}
