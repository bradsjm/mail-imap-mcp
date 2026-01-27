import { afterEach, describe, expect, it } from 'vitest';
import {
  CopyMessageInputSchema,
  DeleteMessageInputSchema,
  GetMessageInputSchema,
  ListAccountsInputSchema,
  ListMailboxesInputSchema,
  SearchMessagesInputSchema,
  UpdateMessageFlagsInputSchema,
  VerifyAccountInputSchema,
} from '../src/contracts.js';
import { MessageIdSchema } from '../src/message-id.js';
import { getHelpText } from '../src/help.js';
import { getListedTools, scrubSecrets, validateEnvironment } from '../src/index.js';

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

  it('accepts empty list accounts input', () => {
    const result = ListAccountsInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects non env-var friendly account ids', () => {
    const result = ListMailboxesInputSchema.safeParse({ account_id: 'bad:id' });
    expect(result.success).toBe(false);
  });

  it('accepts env-var friendly account ids', () => {
    const result = ListMailboxesInputSchema.safeParse({ account_id: 'work_account-1' });
    expect(result.success).toBe(true);
  });

  it('rejects search input without mailbox', () => {
    const result = SearchMessagesInputSchema.safeParse({ account_id: 'default', limit: 10 });
    expect(result.success).toBe(false);
  });

  it('rejects search input mixing last_days with explicit dates', () => {
    const result = SearchMessagesInputSchema.safeParse({
      mailbox: 'INBOX',
      last_days: 5,
      start_date: '2026-01-01',
      limit: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects snippet_max_chars without include_snippet', () => {
    const result = SearchMessagesInputSchema.safeParse({
      mailbox: 'INBOX',
      include_snippet: false,
      snippet_max_chars: 250,
      limit: 10,
    });
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

  it('validates copy message input in same account', () => {
    const result = CopyMessageInputSchema.safeParse({
      account_id: 'default',
      message_id: 'imap:default:INBOX:1:2',
      destination_mailbox: 'Archive',
    });
    expect(result.success).toBe(true);
  });

  it('validates copy message input across accounts', () => {
    const result = CopyMessageInputSchema.safeParse({
      account_id: 'default',
      destination_account_id: 'work',
      message_id: 'imap:default:INBOX:1:2',
      destination_mailbox: 'INBOX',
    });
    expect(result.success).toBe(true);
  });

  it('rejects copy message input with invalid destination account id', () => {
    const result = CopyMessageInputSchema.safeParse({
      account_id: 'default',
      destination_account_id: 'bad:id',
      message_id: 'imap:default:INBOX:1:2',
      destination_mailbox: 'Archive',
    });
    expect(result.success).toBe(false);
  });

  it('defaults verify account id to default', () => {
    const result = VerifyAccountInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.account_id).toBe('default');
    }
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

describe('getHelpText', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('includes defaults and redacts secrets', () => {
    process.env = {
      MAIL_IMAP_DEFAULT_PASS: 'secret',
    };
    const helpText = getHelpText();
    expect(helpText).toContain('MAIL_IMAP_DEFAULT_HOST=<unset>');
    expect(helpText).toContain('MAIL_IMAP_DEFAULT_PORT=993 (default)');
    expect(helpText).toContain('MAIL_IMAP_DEFAULT_SECURE=true (default)');
    expect(helpText).toContain('MAIL_IMAP_DEFAULT_PASS=<redacted> (set)');
    expect(helpText).toContain('MAIL_IMAP_WRITE_ENABLED=false (default)');
  });
});

describe('PDF extraction validation', () => {
  it('accepts valid PDF extraction parameters', () => {
    const result = GetMessageInputSchema.safeParse({
      account_id: 'default',
      message_id: 'imap:default:INBOX:1:2',
      extract_attachment_text: true,
      attachment_text_max_chars: 5000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects attachment_text_max_chars without extract_attachment_text', () => {
    const result = GetMessageInputSchema.safeParse({
      account_id: 'default',
      message_id: 'imap:default:INBOX:1:2',
      extract_attachment_text: false,
      attachment_text_max_chars: 5000,
    });
    expect(result.success).toBe(false);
  });

  it('allows default attachment_text_max_chars when extract_attachment_text is true', () => {
    const result = GetMessageInputSchema.safeParse({
      account_id: 'default',
      message_id: 'imap:default:INBOX:1:2',
      extract_attachment_text: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachment_text_max_chars).toBe(10000);
    }
  });
});
