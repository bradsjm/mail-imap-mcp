import type { ImapFlow } from 'imapflow';

type MailboxLock = Awaited<ReturnType<ImapFlow['getMailboxLock']>>;

type MailboxLockOptions = Readonly<{
  readOnly: boolean;
  description: string;
  expectedUidvalidity?: number;
}>;

export type MailboxLockResult = Readonly<
  { lock: MailboxLock; uidvalidity: number } | { error: string }
>;

/**
 * Open a mailbox lock and optionally validate UIDVALIDITY for message_id operations.
 *
 * Releases the lock before returning an error to avoid leaks.
 */
export async function openMailboxLock(
  client: ImapFlow,
  mailbox: string,
  options: MailboxLockOptions,
): Promise<MailboxLockResult> {
  const lock = await client.getMailboxLock(mailbox, {
    readOnly: options.readOnly,
    description: options.description,
  });

  const mailboxInfo = client.mailbox;
  if (!mailboxInfo) {
    lock.release();
    return { error: 'Mailbox could not be opened.' };
  }

  const uidvalidity = Number(mailboxInfo.uidValidity ?? 0n);
  if (options.expectedUidvalidity !== undefined && uidvalidity !== options.expectedUidvalidity) {
    lock.release();
    return {
      error: `message_id uidvalidity mismatch (expected ${options.expectedUidvalidity}, mailbox ${uidvalidity}).`,
    };
  }

  return { lock, uidvalidity };
}
