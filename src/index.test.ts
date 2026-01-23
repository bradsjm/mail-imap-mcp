import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DeleteMessageInputSchema,
  ListMailboxesInputSchema,
  SearchMessagesInputSchema,
  TOOL_DEFINITIONS,
  UpdateMessageFlagsInputSchema,
} from './contracts.js';
import { MessageIdSchema } from './message-id.js';
import { scrubSecrets } from './index.js';

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
    const tools = TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
    }));

    expect(tools).toMatchSnapshot();
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
