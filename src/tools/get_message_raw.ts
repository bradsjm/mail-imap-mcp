import type { z } from 'zod';

import type { GetMessageRawInputSchema } from '../contracts.js';
import { loadAccountConfig, normalizeEnvSegment } from '../config.js';
import { decodeMessageId } from '../message-id.js';
import {
  makeError,
  makeOk,
  nowUtcIso,
  type ToolHint,
  type ToolResult,
  UNTRUSTED_EMAIL_CONTENT_NOTE,
  withImapClient,
} from './runtime.js';

export async function handleGetMessageRaw(
  args: z.infer<typeof GetMessageRawInputSchema>,
): Promise<ToolResult> {
  const decoded = decodeMessageId(args.message_id);
  if (!decoded) {
    return makeError(
      "Invalid message_id. Expected 'imap:{account_id}:{mailbox}:{uidvalidity}:{uid}'.",
    );
  }
  if (decoded.account_id !== args.account_id) {
    return makeError('message_id does not match the requested account_id.');
  }

  const account = loadAccountConfig(args.account_id);
  if (!account) {
    const prefix = `MAIL_IMAP_${normalizeEnvSegment(args.account_id)}_`;
    return makeError(
      [
        `Account '${args.account_id}' is not configured.`,
        `Set env vars:`,
        `- ${prefix}HOST`,
        `- ${prefix}USER`,
        `- ${prefix}PASS`,
        `Optional: ${prefix}PORT (default 993), ${prefix}SECURE (default true)`,
      ].join('\n'),
    );
  }

  return await withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(decoded.mailbox, {
      readOnly: true,
      description: 'mail_imap_get_message_raw',
    });
    try {
      const mailboxInfo = client.mailbox;
      if (!mailboxInfo) {
        return makeError('Mailbox could not be opened.');
      }
      const uidvalidity = Number(mailboxInfo.uidValidity ?? 0n);
      if (uidvalidity !== decoded.uidvalidity) {
        return makeError(
          `message_id uidvalidity mismatch (expected ${decoded.uidvalidity}, mailbox ${uidvalidity}).`,
        );
      }

      const download = await client.download(decoded.uid, undefined, {
        uid: true,
        maxBytes: args.max_bytes,
      });
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of download.content) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.length;
        if (total > args.max_bytes) {
          return makeError(
            `Raw message exceeds max_bytes (${args.max_bytes}). Increase max_bytes to retrieve more.`,
          );
        }
        chunks.push(buffer);
      }

      const rawSource = Buffer.concat(chunks).toString('utf8');
      const summary = `Fetched raw message ${args.message_id} (${total} bytes).`;
      const hints: ToolHint[] = [
        {
          tool: 'mail_imap_get_message',
          arguments: {
            account_id: args.account_id,
            message_id: args.message_id,
          },
          reason: 'Fetch the parsed message body and headers instead of raw source.',
        },
      ];

      return makeOk(
        summary,
        {
          account_id: args.account_id,
          message_id: args.message_id,
          size_bytes: total,
          raw_source: rawSource,
        },
        hints,
        {
          now_utc: nowUtcIso(),
          read_side_effects: 'none',
          security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
        },
      );
    } finally {
      lock.release();
    }
  });
}
