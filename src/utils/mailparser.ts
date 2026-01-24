import { simpleParser } from 'mailparser';
import type { ParsedMail } from 'mailparser';

/**
 * Parse a raw RFC822 source stream or buffer into a structured ParsedMail.
 */
export const parseMailSource = simpleParser as unknown as (
  source: NodeJS.ReadableStream | Buffer,
) => Promise<ParsedMail>;
