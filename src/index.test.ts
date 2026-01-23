import { afterEach, describe, expect, it } from 'vitest';
import {
  DeleteMessageInputSchema,
  ListMailboxesInputSchema,
  SearchMessagesInputSchema,
  UpdateMessageFlagsInputSchema,
} from './contracts.js';
import { MessageIdSchema } from './message-id.js';
import { getListedTools, scrubSecrets, validateEnvironment } from './index.js';

describe('scrubSecrets', () => {
  it('redacts secret-ish keys recursively', () => {
    const value = scrubSecrets({
      password: 'p',
      token: 't',
      nested: { authorization: 'bearer', ok: 123 },
      list: [{ secret: 's' }],
    });

    expect(value).toEqual({
      password: '[REDACTED]',
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]', ok: 123 },
      list: [{ secret: '[REDACTED]' }],
    });
  });
});

describe('tool contracts', () => {
  it('exposes stable tool list with input schemas', () => {
    expect(getListedTools()).toMatchSnapshot();
  });

  it('validates list mailboxes input', () => {
    const result = ListMailboxesInputSchema.safeParse({ account_id: 'default' });
    expect(result.success).toBe(true);
  });

  it('rejects search input without mailbox', () => {
    const result = SearchMessagesInputSchema.safeParse({ account_id: 'default', limit: 10 });
    expect(result.success).toBe(false);
  });

  it('requires delete confirmation', () => {
    const result = DeleteMessageInputSchema.safeParse({
      account_id: 'default',
      message_id: 'imap:default:INBOX:1:2',
      confirm: false,
    });
    expect(result.success).toBe(false);
  });

  it('requires at least one flag update', () => {
    const result = UpdateMessageFlagsInputSchema.safeParse({
      account_id: 'default',
      message_id: 'imap:default:INBOX:1:2',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed message_id', () => {
    const result = MessageIdSchema.safeParse('imap:missing');
    expect(result.success).toBe(false);
  });
});

describe('validateEnvironment', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reports missing defaults when no accounts are configured', () => {
    process.env = {};
    const errors = validateEnvironment();
    expect(errors).toEqual([
      "Account 'default' is missing required env vars: MAIL_IMAP_DEFAULT_HOST, MAIL_IMAP_DEFAULT_USER, MAIL_IMAP_DEFAULT_PASS",
    ]);
  });

  it('reports missing fields for discovered accounts only', () => {
    process.env = {
      MAIL_IMAP_WORK_HOST: 'imap.example.com',
      MAIL_IMAP_WORK_USER: 'me@example.com',
    };
    const errors = validateEnvironment();
    expect(errors).toEqual(["Account 'work' is missing required env vars: MAIL_IMAP_WORK_PASS"]);
  });
});
