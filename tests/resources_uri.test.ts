import { describe, expect, it } from 'vitest';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  attachmentResourceUri,
  attachmentTextResourceUri,
  decodeMailboxSegment,
  encodeMailboxSegment,
  messageRawResourceUri,
  messageResourceUri,
} from '../src/resources/uri.js';

describe('resources uri helpers', () => {
  it('encodes mailbox names as a single path segment', () => {
    const mailbox = 'Work/Projects 2026';
    const encoded = encodeMailboxSegment(mailbox);
    expect(encoded).not.toContain('/');
    expect(decodeMailboxSegment(encoded)).toBe(mailbox);
  });

  it('builds stable message and attachment URIs', () => {
    const locator = { account_id: 'default', mailbox: 'INBOX/Sub', uidvalidity: 123, uid: 42 };
    expect(messageResourceUri(locator)).toBe('imap://default/mailbox/INBOX%2FSub/message/123/42');
    expect(messageRawResourceUri(locator)).toBe(
      'imap://default/mailbox/INBOX%2FSub/message/123/42/raw',
    );

    const a = { ...locator, part_id: '2.1' };
    expect(attachmentResourceUri(a)).toBe(
      'imap://default/mailbox/INBOX%2FSub/message/123/42/attachment/2.1',
    );
    expect(attachmentTextResourceUri(a)).toBe(
      'imap://default/mailbox/INBOX%2FSub/message/123/42/attachment/2.1/text',
    );
  });

  it('matches resource templates against encoded mailbox segments', () => {
    const t = new ResourceTemplate(
      'imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}',
      {
        list: undefined,
      },
    );
    const uri = 'imap://default/mailbox/Work%2FProjects/message/999/7';
    const match = t.uriTemplate.match(uri);
    expect(match).toBeTruthy();
    expect(match?.['account_id']).toBe('default');
    expect(match?.['mailbox']).toBe('Work%2FProjects');
    expect(match?.['uidvalidity']).toBe('999');
    expect(match?.['uid']).toBe('7');
  });
});
