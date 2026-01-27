import { afterEach, describe, expect, it } from 'vitest';
import { handleListAccounts } from '../src/tools/list_accounts.js';

describe('imap_list_accounts', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('lists configured accounts with host, port, and secure', () => {
    process.env = {
      MAIL_IMAP_DEFAULT_HOST: 'imap.default.example.com',
      MAIL_IMAP_DEFAULT_USER: 'default-user',
      MAIL_IMAP_DEFAULT_PASS: 'default-pass',
      MAIL_IMAP_WORK_HOST: 'imap.work.example.com',
      MAIL_IMAP_WORK_USER: 'work-user',
      MAIL_IMAP_WORK_PASS: 'work-pass',
      MAIL_IMAP_WORK_PORT: '143',
      MAIL_IMAP_WORK_SECURE: 'false',
    };

    const result = handleListAccounts({});
    expect(result.isError).toBe(false);

    const response = JSON.parse(result.content[0].text) as {
      data?: {
        accounts: Array<{ account_id: string; host: string; port: number; secure: boolean }>;
      };
    };

    expect(response.data?.accounts).toEqual(
      expect.arrayContaining([
        {
          account_id: 'default',
          host: 'imap.default.example.com',
          port: 993,
          secure: true,
        },
        {
          account_id: 'work',
          host: 'imap.work.example.com',
          port: 143,
          secure: false,
        },
      ]),
    );

    expect(result.content[0].text).not.toContain('default-user');
    expect(result.content[0].text).not.toContain('work-pass');
  });
});
