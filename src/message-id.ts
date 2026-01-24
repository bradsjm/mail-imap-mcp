import { z } from 'zod';

/**
 * Individual components of a decoded IMAP message identifier.
 *
 * These values uniquely identify a message within the IMAP system and are
 * used to locate and operate on specific messages.
 */
export type MessageIdParts = Readonly<{
  /** The configured IMAP account identifier */
  account_id: string;
  /** The mailbox path containing the message (e.g., 'INBOX') */
  mailbox: string;
  /** The UIDVALIDITY of the mailbox when the message was referenced */
  uidvalidity: number;
  /** The unique identifier (UID) of the message within the mailbox */
  uid: number;
}>;

/** Prefix used to identify message IDs encoded by this system */
export const MESSAGE_ID_PREFIX = 'imap';

/**
 * Encode message identifier components into a stable, human-readable string.
 *
 * Creates a deterministic string representation that can be safely used across
 * tool calls and stored for later reference. The format is designed to be both
 * readable and parseable.
 *
 * @example
 * ```ts
 * encodeMessageId({
 *   account_id: 'default',
 *   mailbox: 'INBOX',
 *   uidvalidity: 1234567890,
 *   uid: 42
 * });
 * // Returns: 'imap:default:INBOX:1234567890:42'
 * ```
 *
 * @param parts - The message identifier components to encode
 * @returns A colon-delimited string containing all identifier components
 */
export function encodeMessageId(parts: MessageIdParts): string {
  return `${MESSAGE_ID_PREFIX}:${parts.account_id}:${parts.mailbox}:${parts.uidvalidity}:${parts.uid}`;
}

/**
 * Decode a message identifier string into its component parts.
 *
 * Parses a colon-delimited message ID and validates that it has the correct
 * format and contains valid values. Returns null if the string is malformed
 * or contains invalid values.
 *
 * Handles mailbox paths that may contain colons by joining all segments
 * between the account ID and the UIDVALIDITY.
 *
 * @example
 * ```ts
 * decodeMessageId('imap:default:INBOX:1234567890:42');
 * // Returns: { account_id: 'default', mailbox: 'INBOX', uidvalidity: 1234567890, uid: 42 }
 *
 * decodeMessageId('imap:default:Sent:2023:2023:Archive:1234567890:42');
 * // Returns: { account_id: 'default', mailbox: 'Sent:2023:2023:Archive', uidvalidity: 1234567890, uid: 42 }
 *
 * decodeMessageId('invalid');
 * // Returns: null
 * ```
 *
 * @param value - The message identifier string to decode
 * @returns The decoded message parts, or null if parsing fails
 */
export function decodeMessageId(value: string): MessageIdParts | null {
  const segments = value.split(':');
  // Must have at least 5 segments: prefix, account_id, mailbox, uidvalidity, uid
  if (segments.length < 5) {
    return null;
  }
  // Must start with the correct prefix to avoid parsing random strings
  if (segments[0] !== MESSAGE_ID_PREFIX) {
    return null;
  }
  const accountId = segments[1];
  const uidvalidityRaw = segments[segments.length - 2];
  const uidRaw = segments[segments.length - 1];
  // Mailbox may contain colons, so we join everything between account_id and uidvalidity
  const mailbox = segments.slice(2, -2).join(':');
  // All components must be non-empty
  if (!accountId || !mailbox || !uidvalidityRaw || !uidRaw) {
    return null;
  }
  // Numeric values must be valid integers and non-negative
  const uidvalidity = Number(uidvalidityRaw);
  const uid = Number(uidRaw);
  if (!Number.isInteger(uidvalidity) || !Number.isInteger(uid) || uidvalidity < 0 || uid < 0) {
    return null;
  }
  return { account_id: accountId, mailbox, uidvalidity, uid };
}

/**
 * Zod schema for validating and parsing message identifier strings.
 *
 * This schema validates that a string is a properly formatted message ID by
 * attempting to decode it using `decodeMessageId()`. It provides user-friendly
 * error messages when validation fails.
 *
 * @example
 * ```ts
 * MessageIdSchema.parse('imap:default:INBOX:1234567890:42'); // OK
 * MessageIdSchema.parse('invalid-id'); // Throws ZodError
 * ```
 */
export const MessageIdSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, ctx) => {
    // Attempt to decode the message ID to verify it's valid
    if (!decodeMessageId(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Invalid message_id format. Expected 'imap:{account_id}:{mailbox}:{uidvalidity}:{uid}'.",
      });
    }
  })
  .describe('Stable IMAP message identifier.');
