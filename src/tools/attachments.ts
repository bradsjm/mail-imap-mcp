import type { ImapFlow, MessageStructureObject } from 'imapflow';

import { extractTextFromPdf } from './pdf.js';
import { truncateText } from './text.js';

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
  if (!node) {
    return;
  }
  const disposition = node.disposition?.toLowerCase();
  const filename =
    node.dispositionParameters?.['filename'] ?? node.parameters?.['name'] ?? undefined;
  const isAttachment = disposition === 'attachment' || disposition === 'inline';
  if (node.part && node.size && isAttachment) {
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

    if (
      extractPdfText &&
      node.type === 'application/pdf' &&
      client &&
      uid > 0 &&
      node.size <= 5_000_000
    ) {
      try {
        const download = await client.download(uid, node.part, {
          uid: true,
          maxBytes: 5_000_000,
        });

        const pdfBuffer = Buffer.isBuffer(download.content)
          ? download.content
          : await (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of download.content) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
              }
              return Buffer.concat(chunks);
            })();

        const extractedText = await extractTextFromPdf(pdfBuffer);
        if (extractedText) {
          entry.extracted_text = truncateText(extractedText, maxTextChars);
        }
      } catch (error) {
        console.error(`Failed to extract text from PDF ${filename || '(unnamed)'}:`, error);
      }
    }

    summaries.push(entry);
  }
  if (node.childNodes) {
    for (const child of node.childNodes) {
      await collectAttachmentSummaries(child, summaries, client, uid, extractPdfText, maxTextChars);
    }
  }
}
