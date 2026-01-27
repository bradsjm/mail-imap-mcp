import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.js';

type ConnectedPair = Readonly<{
  client: Client;
  close: () => Promise<void>;
}>;

async function connectClientToServer(): Promise<ConnectedPair> {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

const connections: ConnectedPair[] = [];

afterEach(async () => {
  while (connections.length > 0) {
    const conn = connections.pop();
    if (conn) {
      await conn.close();
    }
  }
});

function getFirstText(prompt: Awaited<ReturnType<Client['getPrompt']>>): string {
  const first = prompt.messages[0];
  if (!first) {
    return '';
  }
  if (first.content.type === 'text') {
    return first.content.text;
  }
  if (Array.isArray(first.content)) {
    return JSON.stringify(first.content);
  }
  return '';
}

describe('classification prompt pack', () => {
  it('lists classification prompts', async () => {
    const conn = await connectClientToServer();
    connections.push(conn);

    const result = await conn.client.listPrompts();
    const names = new Set(result.prompts.map((prompt) => prompt.name));

    expect(names.has('classify-email-destination')).toBe(true);
    expect(names.has('classify-email-destination-scored')).toBe(true);
    expect(names.has('classify-email-destination-thread-aware')).toBe(true);
  });

  it('auto-discovers allowed destinations via imap_list_mailboxes', async () => {
    const conn = await connectClientToServer();
    connections.push(conn);

    const prompt = await conn.client.getPrompt({
      name: 'classify-email-destination',
      arguments: {
        account_id: 'default',
        message_id: 'imap:default:INBOX:1:2',
        fallback_mailbox: 'default',
        fallback_folder: 'Review/Unsorted',
        body_max_chars: '4000',
        history_mailbox: 'Archive',
        history_limit: '5',
      },
    });

    const text = getFirstText(prompt);
    expect(text).toContain('imap_list_mailboxes');
    expect(text).toContain('ALLOWED_DESTINATIONS');
    expect(text).toContain('Fallback destination');
    expect(text).toContain('"needs_human_review"');
  });

  it('includes evidence scoring rules in scored variant', async () => {
    const conn = await connectClientToServer();
    connections.push(conn);

    const prompt = await conn.client.getPrompt({
      name: 'classify-email-destination-scored',
      arguments: {
        account_id: 'default',
        message_id: 'imap:default:INBOX:1:2',
        fallback_mailbox: 'default',
        fallback_folder: 'Review/Unsorted',
        body_max_chars: '4000',
      },
    });

    const text = getFirstText(prompt);
    expect(text).toContain('Score each allowed destination 0-3');
    expect(text).toContain('best score is <2');
    expect(text).toContain('"top_signals"');
  });

  it('uses prior thread destination rule when provided', async () => {
    const conn = await connectClientToServer();
    connections.push(conn);

    const prompt = await conn.client.getPrompt({
      name: 'classify-email-destination-thread-aware',
      arguments: {
        account_id: 'default',
        message_id: 'imap:default:INBOX:1:2',
        fallback_mailbox: 'default',
        fallback_folder: 'Review/Unsorted',
        prior_thread_mailbox: 'default',
        prior_thread_folder: 'Projects/Alpha',
        body_max_chars: '4000',
      },
    });

    const text = getFirstText(prompt);
    expect(text).toContain('prior_thread_destination');
    expect(text).toContain('Keep the same destination');
  });
});
