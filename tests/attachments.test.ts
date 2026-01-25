import { describe, expect, it } from 'vitest';
import type { MessageStructureObject } from 'imapflow';
import { collectAttachmentSummaries } from '../src/utils/attachments.js';

describe('collectAttachmentSummaries', () => {
  it('caps attachment summaries to the max limit', async () => {
    const children: MessageStructureObject[] = Array.from({ length: 60 }, (_, index) => ({
      part: String(index + 1),
      size: 100,
      type: 'text/plain',
      disposition: 'attachment',
      dispositionParameters: { filename: `file-${index + 1}.txt` },
    }));

    const root: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: children,
    };

    const summaries: Array<{
      filename?: string;
      content_type: string;
      size_bytes: number;
      part_id: string;
      extracted_text?: string;
    }> = [];

    await collectAttachmentSummaries(root, summaries, null, 0, false, 10000, 50);
    expect(summaries).toHaveLength(50);
  });
});
