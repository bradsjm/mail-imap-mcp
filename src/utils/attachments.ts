import type { ImapFlow, MessageStructureObject } from 'imapflow';

import { extractTextFromPdf } from './pdf.js';
import { truncateText } from './text.js';

/**
 * Recursively collect attachment summaries from a message structure.
 *
 * Walks through a message's MIME structure tree, identifying attachments and
 * inline files, and collecting their metadata. Optionally downloads and extracts
 * text from PDF attachments.
 *
 * This function handles nested MIME structures (e.g., multipart/mixed containing
 * multipart/alternative containing text/HTML and attachments). It recursively
 * processes each node to ensure all attachments are discovered.
 *
 * Attachment criteria:
 * - Must have a disposition of 'attachment' or 'inline'
 * - Must have a part identifier and size
 * - Files without a disposition are skipped (likely message body parts)
 *
 * PDF text extraction:
 * - Only performed when extractPdfText=true
 * - Only for PDFs under 5MB (to prevent excessive memory usage)
 * - Requires a valid IMAP client and message UID for downloading
 * - Extracted text is truncated to maxTextChars characters
 *
 * @example
 * const attachments: Array<{
 *   filename?: string;
 *   content_type: string;
 *   size_bytes: number;
 *   part_id: string;
 *   extracted_text?: string;
 * }> = [];
 *
 * await collectAttachmentSummaries(
 *   messageBodyStructure,
 *   attachments,
 *   imapClient,
 *   messageUid,
 *   true,  // extract PDF text
 *   10000  // max chars per PDF
 * );
 * // attachments now contains all attachment metadata
 * ```
 *
 * @param node - The message structure node to process (undefined for top-level call)
 * @param summaries - The array to append attachment summaries to (modified in-place)
 * @param client - The IMAP client for downloading attachments (optional, required for PDF extraction)
 * @param uid - The message UID for downloading attachments (optional, required for PDF extraction)
 * @param extractPdfText - Whether to extract text from PDF attachments (default false)
 * @param maxTextChars - Maximum characters to extract from each PDF (default 10000)
 * @returns A promise that resolves when all attachments have been processed
 */
export async function collectAttachmentSummaries(
  node: MessageStructureObject | undefined,
  summaries: Array<{
    filename?: string;
    content_type: string;
    size_bytes: number;
    part_id: string;
    extracted_text?: string;
  }>,
  client: ImapFlow | null = null,
  uid: number = 0,
  extractPdfText: boolean = false,
  maxTextChars: number = 10000,
): Promise<void> {
  // Base case: stop recursion if there's no node to process
  if (!node) {
    return;
  }
  // Determine if this node represents an attachment by checking its content disposition
  // Valid dispositions: 'attachment' (separate file) or 'inline' (embedded in body)
  const disposition = node.disposition?.toLowerCase();
  const filename =
    node.dispositionParameters?.['filename'] ?? node.parameters?.['name'] ?? undefined;
  const isAttachment = disposition === 'attachment' || disposition === 'inline';

  // Only process nodes that have the required attachment metadata
  if (node.part && node.size && isAttachment) {
    // Create an attachment summary entry with the basic metadata
    // The filename is optional (some attachments may not have one)
    const entry: {
      filename?: string;
      content_type: string;
      size_bytes: number;
      part_id: string;
      extracted_text?: string;
    } = {
      content_type: node.type,
      size_bytes: node.size,
      part_id: node.part,
    };
    if (filename) {
      entry.filename = filename;
    }

    // Attempt to extract text from PDF attachments if requested
    // This is only done for PDFs under 5MB to prevent excessive memory usage
    // Requires a valid IMAP client and message UID to download the attachment
    if (
      extractPdfText &&
      node.type === 'application/pdf' &&
      client &&
      uid > 0 &&
      node.size <= 5_000_000
    ) {
      try {
        // Download the PDF attachment up to 5MB
        const download = await client.download(uid, node.part, {
          uid: true,
          maxBytes: 5_000_000,
        });

        // Ensure we have a Buffer for the PDF content
        // The download may return a stream or a Buffer, so we handle both cases
        const pdfBuffer = Buffer.isBuffer(download.content)
          ? download.content
          : await (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of download.content) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
              }
              return Buffer.concat(chunks);
            })();

        // Extract text from the PDF using pdf-parse library
        const extractedText = await extractTextFromPdf(pdfBuffer);
        if (extractedText) {
          // Truncate the extracted text to the maximum character limit
          entry.extracted_text = truncateText(extractedText, maxTextChars);
        }
      } catch (error) {
        // Log errors but don't fail the entire operation if PDF extraction fails
        // PDFs may be corrupted, password-protected, or have other issues
        console.error(`Failed to extract text from PDF ${filename || '(unnamed)'}:`, error);
      }
    }

    // Add the attachment summary to the results array
    summaries.push(entry);
  }

  // Recursively process child nodes to find nested attachments
  // MIME messages can have complex structures with multiple levels of nesting
  if (node.childNodes) {
    for (const child of node.childNodes) {
      await collectAttachmentSummaries(child, summaries, client, uid, extractPdfText, maxTextChars);
    }
  }
}
