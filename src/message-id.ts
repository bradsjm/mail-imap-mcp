import { z } from 'zod';

export type MessageIdParts = Readonly<{
  account_id: string;
  mailbox: string;
  uidvalidity: number;
  uid: number;
}>;

export const MESSAGE_ID_PREFIX = 'imap';

export function encodeMessageId(parts: MessageIdParts): string {
  return `${MESSAGE_ID_PREFIX}:${parts.account_id}:${parts.mailbox}:${parts.uidvalidity}:${parts.uid}`;
}

export function decodeMessageId(value: string): MessageIdParts | null {
  const segments = value.split(':');
  if (segments.length < 5) {
    return null;
  }
  if (segments[0] !== MESSAGE_ID_PREFIX) {
    return null;
  }
  const accountId = segments[1];
  const uidvalidityRaw = segments[segments.length - 2];
  const uidRaw = segments[segments.length - 1];
  const mailbox = segments.slice(2, -2).join(':');
  if (!accountId || !mailbox || !uidvalidityRaw || !uidRaw) {
    return null;
  }
  const uidvalidity = Number(uidvalidityRaw);
  const uid = Number(uidRaw);
  if (!Number.isInteger(uidvalidity) || !Number.isInteger(uid) || uidvalidity < 0 || uid < 0) {
    return null;
  }
  return { account_id: accountId, mailbox, uidvalidity, uid };
}

export const MessageIdSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, ctx) => {
    if (!decodeMessageId(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Invalid message_id format. Expected 'imap:{account_id}:{mailbox}:{uidvalidity}:{uid}'.",
      });
    }
  })
  .describe('Stable IMAP message identifier.');
