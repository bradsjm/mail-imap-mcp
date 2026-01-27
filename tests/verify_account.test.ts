import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountConfig } from '../src/config.js';

type ToolHint = Readonly<{
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}>;

type ToolResult = {
  isError: boolean;
  content: [{ type: 'text'; text: string }];
  structuredContent?: Record<string, unknown>;
};

vi.mock('../src/tools/runtime.js', () => {
  const encode = (
    summary: string,
    data: Record<string, unknown> | undefined,
    hints: ToolHint[],
    meta?: Record<string, unknown>,
  ): string => {
    const base = data ? { summary, data, hints } : { summary, error: { message: summary }, hints };
    const withMeta = meta ? { ...base, _meta: meta } : base;
    return JSON.stringify(withMeta);
  };

  const makeOk = (
    summary: string,
    data: Record<string, unknown>,
    hints: ToolHint[] = [],
    meta?: Record<string, unknown>,
  ): ToolResult => ({
    isError: false,
    content: [{ type: 'text', text: encode(summary, data, hints, meta) }],
    structuredContent: data,
  });

  const makeError = (
    message: string,
    hints: ToolHint[] = [],
    meta?: Record<string, unknown>,
  ): ToolResult => ({
    isError: true,
    content: [{ type: 'text', text: encode(message, undefined, hints, meta) }],
  });

  return {
    makeOk,
    makeError,
    nowUtcIso: () => '2026-01-27T00:00:00.000Z',
    withImapClient: vi.fn(),
  };
});

vi.mock('../src/utils/account.js', () => ({
  loadAccountOrError: vi.fn(),
}));

import { handleVerifyAccount } from '../src/tools/verify_account.js';
import { withImapClient } from '../src/tools/runtime.js';
import { loadAccountOrError } from '../src/utils/account.js';

const sampleAccount: AccountConfig = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'user',
  pass: 'pass',
};

describe('imap_verify_account', () => {
  beforeEach(() => {
    vi.mocked(loadAccountOrError).mockReset();
    vi.mocked(withImapClient).mockReset();
  });

  it('verifies connectivity and returns capabilities', async () => {
    vi.mocked(loadAccountOrError).mockReturnValue({ account: sampleAccount });

    vi.mocked(withImapClient).mockImplementation((_account, fn) => {
      const client = {
        noop: vi.fn(() => Promise.resolve(undefined)),
        capabilities: new Map<string, boolean | number>([
          ['UIDPLUS', true],
          ['IMAP4rev1', true],
          ['X-DISABLED', false],
        ]),
      };
      return fn(client as never);
    });

    const result = await handleVerifyAccount({ account_id: 'default' });
    expect(result.isError).toBe(false);

    const response = JSON.parse(result.content[0].text) as {
      data?: {
        account_id: string;
        ok: true;
        latency_ms: number;
        server: { host: string; port: number; secure: boolean };
        capabilities: string[];
      };
    };

    expect(response.data?.account_id).toBe('default');
    expect(response.data?.ok).toBe(true);
    expect(response.data?.server).toEqual({
      host: 'imap.example.com',
      port: 993,
      secure: true,
    });
    expect(response.data?.capabilities).toEqual(['IMAP4rev1', 'UIDPLUS']);
    expect(response.data?.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns a configuration error when the account is missing', async () => {
    vi.mocked(loadAccountOrError).mockReturnValue({ error: 'Account missing.' });

    const result = await handleVerifyAccount({ account_id: 'default' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Account missing.');
    expect(withImapClient).not.toHaveBeenCalled();
  });
});
