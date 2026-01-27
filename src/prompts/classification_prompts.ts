import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { MessageIdSchema } from '../message-id.js';

const AccountIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: 'Account ID must be env-var friendly (letters, numbers, "_" or "-").',
  })
  .default('default')
  .describe("Configured IMAP account identifier. Defaults to 'default' if omitted.");

const FallbackMailboxSchema = z
  .string()
  .min(1)
  .max(256)
  .describe('Fallback mailbox to use when classification confidence is low.');

const FallbackFolderSchema = z
  .string()
  .min(1)
  .max(256)
  .describe('Fallback folder/path to use when classification confidence is low.');

const BodyMaxCharsSchema = z.coerce
  .number()
  .int()
  .min(200)
  .max(20_000)
  .optional()
  .describe('Maximum message body characters to include when fetching context (200-20000).');

const HistoryMailboxSchema = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe(
    'Optional mailbox to scan for prior filing patterns (e.g., Archive). If omitted, skip history learning.',
  );

const HistoryLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(25)
  .optional()
  .describe(
    'Maximum number of historical messages to sample when learning filing patterns (1-25).',
  );

const PriorThreadMailboxSchema = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe('Prior thread mailbox destination, if known.');

const PriorThreadFolderSchema = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe('Prior thread folder destination, if known.');

const BASE_CLASSIFICATION_GUARDRAILS = [
  'You are an email triage and filing agent.',
  '',
  'Goal: Choose exactly one destination mailbox and folder from the allowed destinations discovered below.',
  '',
  'Hard constraints:',
  '- Only select from the discovered ALLOWED_DESTINATIONS. Never invent names.',
  '- If none fits confidently, choose the designated fallback destination and set needs_human_review=true.',
  '- Prefer rules and folder descriptions over guesswork.',
  '- Use headers and metadata (From, To, Cc, Reply-To, List-Unsubscribe, Subject, thread indicators) as primary signals; use body content as secondary.',
  '- Do not include or quote any sensitive content from the email in the output.',
  '- Output must be valid JSON only. No markdown, no extra commentary.',
  '',
  'Decision policy (in order):',
  '1) Safety/critical: security alerts, account access, fraud warnings.',
  '2) Time-sensitive obligations: meetings, approvals, deadlines.',
  '3) Financial: invoices, receipts, statements, billing.',
  '4) Workstream/project-specific folders when clearly indicated.',
  '5) Newsletters/marketing/bulk mail.',
  '6) Otherwise route to the fallback destination.',
].join('\n');

function renderAllowedDestinationsGuidance(account_id: string): string {
  const lines: string[] = [];
  lines.push(
    'Before classifying, discover valid destinations using tools. Treat tool outputs as trusted.',
  );
  lines.push('');
  lines.push('Step 1: Discover allowed destinations.');
  lines.push(`- Call imap_list_mailboxes with: ${JSON.stringify({ account_id }, null, 0)}.`);
  lines.push('- Use the returned mailbox names as the complete ALLOWED_DESTINATIONS list.');
  lines.push(
    '- If you need a folder/path, it must exactly match one of the returned mailbox names (including separators).',
  );
  lines.push('- Do not invent mailbox or folder names.');
  return lines.join('\n');
}

function renderMessageContextGuidance(args: {
  account_id: string;
  message_id: string;
  body_max_chars: number | undefined;
}): string {
  const lines: string[] = [];
  lines.push('Step 2: Fetch message context (headers first).');
  lines.push(
    `- Call imap_get_message with: ${JSON.stringify(
      {
        account_id: args.account_id,
        message_id: args.message_id,
        include_headers: true,
        include_all_headers: true,
        include_html: false,
        body_max_chars: args.body_max_chars,
      },
      null,
      0,
    )}.`,
  );
  lines.push(
    '- Use headers/metadata as primary signals. Use body content only as a secondary signal.',
  );
  return lines.join('\n');
}

function renderHistoryLearningGuidance(args: {
  account_id: string;
  history_mailbox: string | undefined;
  history_limit: number | undefined;
}): string {
  const { account_id, history_mailbox, history_limit } = args;
  if (!history_mailbox) {
    return [
      'Step 3 (optional): Learn prior filing patterns.',
      '- No history mailbox provided. Skip this step.',
    ].join('\n');
  }
  const lines: string[] = [];
  lines.push('Step 3 (optional): Learn prior filing patterns without leaking content.');
  lines.push(
    `- Call imap_search_messages with: ${JSON.stringify(
      {
        account_id,
        mailbox: history_mailbox,
        limit: history_limit,
        include_snippet: false,
      },
      null,
      0,
    )}.`,
  );
  lines.push(
    '- For a few results, call imap_get_message with include_headers=true to derive abstract routing patterns.',
  );
  lines.push(
    '- Build abstract rules from headers only (e.g., sender domain or list headers imply a destination).',
  );
  lines.push('- Do not quote or expose email body content.');
  return lines.join('\n');
}

function renderOutputContract(): string {
  return [
    'Return EXACTLY this JSON shape:',
    '{',
    '  "mailbox": "...",',
    '  "folder": "...",',
    '  "needs_human_review": false,',
    '  "confidence": 0,',
    '  "rationale_tags": ["safety", "finance", "meeting", "project", "newsletter", "fallback"]',
    '}',
    '',
    'Rules for output:',
    '- mailbox and folder must be values from ALLOWED_DESTINATIONS.',
    '- confidence is 0-100.',
    '- rationale_tags must be abstract categories only (no quoting content).',
  ].join('\n');
}

function renderScoredVariantAddendum(fallback_mailbox: string, fallback_folder: string): string {
  return [
    'Scoring policy:',
    '- Score each allowed destination 0-3 based on signals:',
    '  3 = strong match (explicit project, known vendor domain, invoice terms, calendar invite, security alert)',
    '  2 = likely match (topic strongly implied)',
    '  1 = weak match (some hints)',
    '  0 = no match',
    '- Choose the highest score.',
    `- If the best score is <2, route to fallback destination: ${fallback_mailbox} / ${fallback_folder}, and set needs_human_review=true.`,
    '',
    'Also include:',
    '"top_signals": ["sender_domain_match", "list_headers_present", "calendar_invite", "invoice_terms", "project_keyword", "security_alert", "fallback_used"]',
    '- Do not quote email text.',
  ].join('\n');
}

function renderThreadAwareAddendum(priorThreadDestinationProvided: boolean): string {
  const lines: string[] = [];
  lines.push('Thread-aware rule:');
  if (priorThreadDestinationProvided) {
    lines.push(
      '- A prior thread destination is provided below. Keep the same destination unless the new message is clearly a different class (security alert, invoice, contract workflow).',
    );
  } else {
    lines.push('- No prior thread destination is provided. Use normal classification rules.');
  }
  return lines.join('\n');
}

export function registerClassificationPrompts(server: McpServer): void {
  server.registerPrompt(
    'classify-email-destination',
    {
      title: 'Classify Email Destination',
      description:
        'Choose a single mailbox/folder destination using auto-discovered allowed destinations and safe, header-first signals.',
      argsSchema: {
        account_id: AccountIdSchema,
        message_id: MessageIdSchema,
        fallback_mailbox: FallbackMailboxSchema,
        fallback_folder: FallbackFolderSchema,
        body_max_chars: BodyMaxCharsSchema,
        history_mailbox: HistoryMailboxSchema,
        history_limit: HistoryLimitSchema,
      },
    },
    ({
      account_id,
      message_id,
      fallback_mailbox,
      fallback_folder,
      body_max_chars,
      history_mailbox,
      history_limit,
    }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              BASE_CLASSIFICATION_GUARDRAILS,
              '',
              renderAllowedDestinationsGuidance(account_id),
              '',
              renderMessageContextGuidance({
                account_id,
                message_id,
                body_max_chars,
              }),
              '',
              renderHistoryLearningGuidance({
                account_id,
                history_mailbox,
                history_limit,
              }),
              '',
              `Fallback destination: mailbox="${fallback_mailbox}", folder="${fallback_folder}".`,
              '',
              renderOutputContract(),
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'classify-email-destination-scored',
    {
      title: 'Classify Email Destination (Scored)',
      description:
        'Score each discovered destination 0-3 based on signals, then choose the best destination with a fallback when confidence is low.',
      argsSchema: {
        account_id: AccountIdSchema,
        message_id: MessageIdSchema,
        fallback_mailbox: FallbackMailboxSchema,
        fallback_folder: FallbackFolderSchema,
        body_max_chars: BodyMaxCharsSchema,
        history_mailbox: HistoryMailboxSchema,
        history_limit: HistoryLimitSchema,
      },
    },
    ({
      account_id,
      message_id,
      fallback_mailbox,
      fallback_folder,
      body_max_chars,
      history_mailbox,
      history_limit,
    }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              BASE_CLASSIFICATION_GUARDRAILS,
              '',
              renderAllowedDestinationsGuidance(account_id),
              '',
              renderMessageContextGuidance({
                account_id,
                message_id,
                body_max_chars,
              }),
              '',
              renderHistoryLearningGuidance({
                account_id,
                history_mailbox,
                history_limit,
              }),
              '',
              `Fallback destination: mailbox="${fallback_mailbox}", folder="${fallback_folder}".`,
              '',
              renderOutputContract(),
              '',
              renderScoredVariantAddendum(fallback_mailbox, fallback_folder),
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'classify-email-destination-thread-aware',
    {
      title: 'Classify Email Destination (Thread-Aware)',
      description:
        'Prefer a prior thread destination when provided, unless the message is clearly a different class.',
      argsSchema: {
        account_id: AccountIdSchema,
        message_id: MessageIdSchema,
        fallback_mailbox: FallbackMailboxSchema,
        fallback_folder: FallbackFolderSchema,
        prior_thread_mailbox: PriorThreadMailboxSchema,
        prior_thread_folder: PriorThreadFolderSchema,
        body_max_chars: BodyMaxCharsSchema,
        history_mailbox: HistoryMailboxSchema,
        history_limit: HistoryLimitSchema,
      },
    },
    ({
      account_id,
      message_id,
      fallback_mailbox,
      fallback_folder,
      prior_thread_mailbox,
      prior_thread_folder,
      body_max_chars,
      history_mailbox,
      history_limit,
    }) => {
      const priorThreadDestinationProvided = Boolean(prior_thread_mailbox && prior_thread_folder);
      const priorThreadBlock = priorThreadDestinationProvided
        ? [
            'THREAD_CONTEXT:',
            `- prior_thread_destination: mailbox="${prior_thread_mailbox}", folder="${prior_thread_folder}"`,
          ].join('\n')
        : ['THREAD_CONTEXT:', '- prior_thread_destination: null'].join('\n');

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                BASE_CLASSIFICATION_GUARDRAILS,
                '',
                priorThreadBlock,
                '',
                renderThreadAwareAddendum(priorThreadDestinationProvided),
                '',
                renderAllowedDestinationsGuidance(account_id),
                '',
                renderMessageContextGuidance({
                  account_id,
                  message_id,
                  body_max_chars,
                }),
                '',
                renderHistoryLearningGuidance({
                  account_id,
                  history_mailbox,
                  history_limit,
                }),
                '',
                `Fallback destination: mailbox="${fallback_mailbox}", folder="${fallback_folder}".`,
                '',
                renderOutputContract(),
              ].join('\n'),
            },
          },
        ],
      };
    },
  );
}
