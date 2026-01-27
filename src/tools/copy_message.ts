import type { z } from 'zod';

import type { CopyMessageInputSchema } from '../contracts.js';
import { encodeMessageId } from '../message-id.js';
import { loadAccountOrError } from '../utils/account.js';
import { openMailboxLock } from '../utils/mailbox.js';
import { decodeMessageIdOrError } from '../utils/message_id.js';
import {
  hasCapability,
  makeError,
  makeOk,
  nowUtcIso,
  type ToolHint,
  type ToolResult,
  withImapClient,
} from './runtime.js';

function extractAppendMeta(value: unknown): { uid?: number; uidValidity?: bigint } {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  const uid = typeof record['uid'] === 'number' ? record['uid'] : undefined;
  const uidValidity = typeof record['uidValidity'] === 'bigint' ? record['uidValidity'] : undefined;
  const result: { uid?: number; uidValidity?: bigint } = {};
  if (uid !== undefined) {
    result.uid = uid;
  }
  if (uidValidity !== undefined) {
    result.uidValidity = uidValidity;
  }
  return result;
}

/**
 * Handle the imap_copy_message tool call.
 *
 * Copies a single message to a destination mailbox, either within the same
 * account (via IMAP COPY) or across accounts (via download + append).
 */
export async function handleCopyMessage(
  args: z.infer<typeof CopyMessageInputSchema>,
): Promise<ToolResult> {
  const decodedResult = decodeMessageIdOrError(args.message_id, args.account_id);
  if ('error' in decodedResult) {
    return makeError(decodedResult.error);
  }

  const destinationAccountId = args.destination_account_id ?? args.account_id;

  const sourceAccountResult = loadAccountOrError(args.account_id);
  if ('error' in sourceAccountResult) {
    return makeError(sourceAccountResult.error);
  }
  const destinationAccountResult = loadAccountOrError(destinationAccountId);
  if ('error' in destinationAccountResult) {
    return makeError(destinationAccountResult.error);
  }

  const decoded = decodedResult.decoded;
  const sourceAccount = sourceAccountResult.account;
  const destinationAccount = destinationAccountResult.account;
  const sameAccount = destinationAccountId === args.account_id;

  return await withImapClient(sourceAccount, async (sourceClient) => {
    const lockResult = await openMailboxLock(sourceClient, decoded.mailbox, {
      readOnly: sameAccount ? false : true,
      description: 'imap_copy_message',
      expectedUidvalidity: decoded.uidvalidity,
    });
    if ('error' in lockResult) {
      return makeError(lockResult.error);
    }

    const { lock } = lockResult;
    try {
      if (sameAccount) {
        const supportsUidplus = hasCapability(sourceClient, 'UIDPLUS');
        const copyResult = await sourceClient.messageCopy(decoded.uid, args.destination_mailbox, {
          uid: true,
        });

        if (!copyResult) {
          return makeError('Copy failed for this message.', [], {
            copy_strategy: 'same-account-copy',
          });
        }

        let newMessageId: string | undefined;
        if (supportsUidplus) {
          const newUid = copyResult.uidMap?.get(decoded.uid);
          const newUidvalidity = copyResult.uidValidity ?? undefined;
          if (newUid !== undefined && newUidvalidity !== undefined) {
            newMessageId = encodeMessageId({
              account_id: destinationAccountId,
              mailbox: args.destination_mailbox,
              uidvalidity: Number(newUidvalidity),
              uid: newUid,
            });
          }
        }

        const summary = `Copied message ${args.message_id} to ${args.destination_mailbox}.`;
        const hints: ToolHint[] = [];
        if (newMessageId) {
          hints.push({
            tool: 'imap_get_message',
            arguments: {
              account_id: destinationAccountId,
              message_id: newMessageId,
            },
            reason: 'Fetch the copied message in its destination mailbox.',
          });
        }

        return makeOk(
          summary,
          {
            source_account_id: args.account_id,
            destination_account_id: destinationAccountId,
            source_mailbox: decoded.mailbox,
            destination_mailbox: args.destination_mailbox,
            message_id: args.message_id,
            new_message_id: newMessageId,
          },
          hints,
          {
            now_utc: nowUtcIso(),
            copy_strategy: 'same-account-copy',
            uidplus: supportsUidplus,
          },
        );
      }

      const fetched = await sourceClient.fetchOne(
        decoded.uid,
        { uid: true, flags: true, internalDate: true },
        { uid: true },
      );
      if (!fetched) {
        return makeError('Message not found.');
      }

      const download = await sourceClient.download(decoded.uid, undefined, {
        uid: true,
      });
      if (!download?.content) {
        return makeError('Failed to download message source for cross-account copy.');
      }
      const chunks: Buffer[] = [];
      for await (const chunk of download.content) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        chunks.push(buffer);
      }
      const rawSource = Buffer.concat(chunks);

      const flags = fetched.flags ? Array.from(fetched.flags) : undefined;
      const internalDate = fetched.internalDate instanceof Date ? fetched.internalDate : undefined;

      const appendResult = await withImapClient(destinationAccount, async (destinationClient) => {
        return await destinationClient.append(
          args.destination_mailbox,
          rawSource,
          flags,
          internalDate,
        );
      });

      let newMessageId: string | undefined;
      const { uid: appendUid, uidValidity: appendUidvalidity } = extractAppendMeta(appendResult);
      if (typeof appendUid === 'number' && appendUidvalidity !== undefined) {
        newMessageId = encodeMessageId({
          account_id: destinationAccountId,
          mailbox: args.destination_mailbox,
          uidvalidity: Number(appendUidvalidity),
          uid: appendUid,
        });
      }

      const summary = `Copied message ${args.message_id} to ${destinationAccountId}:${args.destination_mailbox}.`;
      const hints: ToolHint[] = newMessageId
        ? [
            {
              tool: 'imap_get_message',
              arguments: {
                account_id: destinationAccountId,
                message_id: newMessageId,
              },
              reason: 'Fetch the copied message in the destination account/mailbox.',
            },
          ]
        : [
            {
              tool: 'imap_search_messages',
              arguments: {
                account_id: destinationAccountId,
                mailbox: args.destination_mailbox,
                limit: 10,
              },
              reason: 'List messages in the destination mailbox to confirm the copy.',
            },
          ];

      return makeOk(
        summary,
        {
          source_account_id: args.account_id,
          destination_account_id: destinationAccountId,
          source_mailbox: decoded.mailbox,
          destination_mailbox: args.destination_mailbox,
          message_id: args.message_id,
          new_message_id: newMessageId,
        },
        hints,
        {
          now_utc: nowUtcIso(),
          copy_strategy: 'cross-account-append',
          destination_account_different: true,
        },
      );
    } finally {
      lock.release();
    }
  });
}
