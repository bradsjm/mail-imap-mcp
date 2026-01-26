# PDF Text Extraction Implementation

## Overview

This document describes the implementation of PDF text extraction functionality for the `imap_get_message` tool in the mail-imap-mcp server. The feature allows users to extract text content from PDF attachments directly within the MCP server, eliminating the need to download and process PDFs separately.

## Feature Summary

- **Library Used**: `pdf-parse` (v2.4.5) - Pure TypeScript PDF parsing library
- **Integration Point**: `imap_get_message` tool
- **Default Behavior**: Disabled (opt-in via `extract_attachment_text` parameter)
- **Size Limits**: PDFs up to 5MB, extracted text up to 50KB per attachment
- **Error Handling**: Graceful degradation - extraction failures don't fail the entire request

## Technical Implementation

### Dependencies Added

```json
{
  "dependencies": {
    "pdf-parse": "^2.4.5"
  }
}
```

### Code Changes

#### 1. Import Statement

```typescript
// src/index.ts (L23)
import { PDFParse } from 'pdf-parse';
```

#### 2. PDF Extraction Function

```typescript
// src/index.ts (L697-708)
async function extractTextFromPdf(buffer: Buffer): Promise<string | null> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    return result.text || null;
  } catch (error) {
    console.error('PDF extraction failed:', error);
    return null;
  }
}
```

**Design Decisions:**

- Uses `PDFParse` class for proper resource management
- Explicitly calls `destroy()` to clean up resources
- Returns `null` on failure to allow graceful degradation
- Logs errors for debugging without throwing

#### 3. Enhanced Attachment Collection

```typescript
// src/index.ts (L710-776)
async function collectAttachmentSummaries(
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
  // ... existing attachment collection logic ...

  // Extract text from PDF attachments if requested
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

      // Buffer the content if it's a Readable stream
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

  // ... rest of function ...
}
```

**Key Improvements:**

- Converted synchronous function to async
- Added optional parameters for PDF extraction control
- Added `extracted_text` field to attachment output schema
- Implemented proper stream buffering for `download.content`
- Added size validation (5MB limit)
- Added error handling per attachment (non-blocking)

#### 4. Schema Updates

```typescript
// src/contracts.ts (L148-160)
export const GetMessageInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    body_max_chars: z.number().int().min(100).max(20000).default(2000),
    include_headers: z.boolean().default(true),
    include_all_headers: z
      .boolean()
      .default(false)
      .describe('If true, include all headers (may be large/noisy). Implies include_headers.'),
    include_html: z.boolean().default(false),
    extract_attachment_text: z
      .boolean()
      .default(false)
      .describe('If true, extract text from PDF attachments (may be slow).'),
    attachment_text_max_chars: z
      .number()
      .int()
      .min(100)
      .max(50000)
      .default(10000)
      .describe(
        'Maximum text length to extract from each PDF attachment when extract_attachment_text is true (100-50000).',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.extract_attachment_text !== true && value.attachment_text_max_chars !== 10000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'attachment_text_max_chars is only valid when extract_attachment_text is true.',
        path: ['attachment_text_max_chars'],
      });
    }
  });
```

**Validation Logic:**

- `extract_attachment_text` defaults to `false` (opt-in)
- `attachment_text_max_chars` defaults to 10,000 characters
- Range validation: 100-50,000 characters
- Cross-parameter validation: `attachment_text_max_chars` only valid when extraction enabled

```typescript
// src/contracts.ts (L228-231)
export const AttachmentSummarySchema = z
  .object({
    filename: z.string().min(1).max(256).optional(),
    content_type: z.string().min(1).max(128),
    size_bytes: z.number().int().nonnegative(),
    part_id: z.string().min(1).max(128),
    extracted_text: z.string().min(1).max(50000).optional(),
  })
  .strict();
```

**Output Schema:**

- Added optional `extracted_text` field to attachment summary
- Max length: 50,000 characters
- Optional field - only present when extraction succeeds

#### 5. Tool Handler Integration

```typescript
// src/index.ts (L1409-1418)
await collectAttachmentSummaries(
  fetched.bodyStructure,
  attachments,
  client,
  decoded.uid,
  args.extract_attachment_text,
  args.attachment_text_max_chars,
);
```

**Integration Points:**

- Passes IMAP client for downloading attachments
- Passes message UID for targeted downloads
- Passes extraction flags from user input
- Passes character limit for truncation

## Design Decisions

### 1. Opt-In Approach

**Decision**: PDF extraction is disabled by default (`extract_attachment_text: false`)

**Rationale**:

- Performance: PDF extraction is resource-intensive
- Privacy: Not all users want attachment content processed
- Compatibility: Maintains backward compatibility
- Control: Users explicitly choose when to extract

### 2. Size Limits

**Decision**: 5MB PDF limit, 50KB text limit per attachment

**Rationale**:

- 5MB PDF: Prevents memory issues with large attachments
- 50KB text: Balances utility with response size
- Limits prevent abuse and resource exhaustion
- Still covers most use cases (invoices, reports, contracts)

### 3. Error Handling Strategy

**Decision**: Graceful degradation - extraction failures logged but not thrown

**Rationale**:

- Non-blocking: One failed PDF shouldn't fail entire request
- User experience: Still get message body and other attachments
- Debugging: Server logs provide context for failures
- Flexibility: Allows partial success scenarios

### 4. Stream Buffering

**Decision**: Explicitly buffer `download.content` as it may be a Readable stream

**Rationale**:

- `imapflow` may return streams or buffers
- `pdf-parse` requires Buffer/Uint8Array input
- Async iteration handles both cases safely
- Prevents type errors at runtime

### 5. Resource Management

**Decision**: Explicitly call `parser.destroy()` after extraction

**Rationale**:

- `PDFParse` maintains internal resources
- Prevents memory leaks in long-running processes
- Follows library best practices
- Ensures clean state between extractions

## Performance Considerations

### Estimated Resource Usage

| Operation                | Memory          | CPU          | Network       | Time           |
| ------------------------ | --------------- | ------------ | ------------- | -------------- |
| Without extraction       | ~10MB           | Low          | ~500KB        | 0.5-2s         |
| With 1 small PDF (<1MB)  | ~15MB           | Medium       | +1MB          | +2-3s          |
| With 1 large PDF (1-5MB) | ~20MB           | High         | +5MB          | +5-13s         |
| With multiple PDFs       | +5-10MB per PDF | High per PDF | +size per PDF | +2-10s per PDF |

### Optimization Strategies

1. **Selective Extraction**: Only enable when needed
2. **Small Previews**: Use low `attachment_text_max_chars` for initial review
3. **Early Filtering**: Use search to identify PDF-containing messages
4. **Parallel Processing**: Attachments processed sequentially (future: parallel)
5. **Caching**: Not implemented (future: cache extraction results)

## Testing

### Unit Tests Added

```typescript
// src/index.test.ts (L111-137)
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
```

**Test Coverage**:

- ✅ Schema validation with extraction enabled
- ✅ Cross-parameter validation
- ✅ Default value handling
- ❌ Integration tests (require IMAP server setup)
- ❌ PDF parsing edge cases (require sample PDFs)

### Snapshot Updates

Updated `src/__snapshots__/index.test.ts.snap` to reflect:

- New parameters in `imap_get_message` schema
- Updated tool description
- Property ordering (alphabetical per Zod)

## Limitations

### Current Limitations

1. **OCR Not Supported**: Image-based/scanned PDFs return empty text
2. **Size Cap**: PDFs > 5MB are silently skipped
3. **Sequential Processing**: Multiple PDFs processed one at a time
4. **No Caching**: Same PDF re-downloaded on subsequent requests
5. **Layout Loss**: Tables, multi-column layouts may lose structure
6. **Encoding Issues**: Non-Latin characters may be garbled

### Known Issues

1. **Memory Spike**: Large PDFs cause temporary memory increase
2. **Timeout Risk**: Very slow PDFs may hit socket timeout
3. **Stream Handling**: Edge cases with streaming content not fully tested

## Security Considerations

### Input Validation

- ✅ PDF size limit prevents DoS via large attachments
- ✅ Text length limit prevents response size abuse
- ✅ Content type validation (only `application/pdf`)
- ✅ Parameter validation via Zod schemas

### Data Handling

- ✅ No temporary files created (in-memory processing)
- ✅ Extracted text truncated before transmission
- ✅ Error messages don't leak sensitive paths
- ✅ Attachment content not persisted

### Attack Vectors

1. **Malicious PDFs**: `pdf-parse` library handles malformed input
2. **Resource Exhaustion**: Size limits prevent abuse
3. **Path Traversal**: No file system access
4. **Injection**: Text extracted as plain strings, not executed

## Future Enhancements

### Potential Improvements

1. **OCR Integration**: Add Tesseract.js for scanned PDFs
2. **Parallel Processing**: Extract multiple PDFs concurrently
3. **Caching Layer**: Cache extraction results by attachment hash
4. **Progressive Loading**: Stream text as it's extracted
5. **Metadata Extraction**: Extract PDF metadata (author, creation date)
6. **Format Preservation**: Better table and layout handling
7. **Compression**: Compress extracted text if > 10KB
8. **Configurable Limits**: Allow runtime configuration of limits

### Alternative Libraries Considered

- **pdfjs-dist**: More powerful but larger bundle
- **pdf2json**: Better for structured data but slower
- **unpdf**: Cross-runtime but less mature
- **pdfreader**: Specialized for tables

## Usage Examples

### Basic Usage

```typescript
// Extract text from PDFs with default 10KB limit
{
  "tool": "imap_get_message",
  "arguments": {
    "account_id": "default",
    "message_id": "imap:default:INBOX:1234567890:42",
    "extract_attachment_text": true
  }
}
```

### Custom Text Limit

```typescript
// Extract up to 5KB per PDF
{
  "tool": "imap_get_message",
  "arguments": {
    "account_id": "default",
    "message_id": "imap:default:INBOX:1234567890:42",
    "extract_attachment_text": true,
    "attachment_text_max_chars": 5000
  }
}
```

### Full Extraction

```typescript
// Extract up to 50KB per PDF
{
  "tool": "imap_get_message",
  "arguments": {
    "account_id": "default",
    "message_id": "imap:default:INBOX:1234567890:42",
    "extract_attachment_text": true,
    "attachment_text_max_chars": 50000
  }
}
```

## Documentation

### Files Created

1. **examples/pdf-extraction.md**: Comprehensive usage examples and best practices
2. **docs/PDF_EXTRACTION_IMPLEMENTATION.md**: This file (technical implementation details)

### Files Updated

1. **README.md**: Added PDF extraction to capabilities and tool documentation
2. **src/contracts.ts**: Schema updates for parameters and output
3. **src/index.ts**: Core implementation
4. **src/index.test.ts**: Test cases
5. **src/**snapshots**/index.test.ts.snap**: Updated snapshots

## Conclusion

The PDF text extraction feature provides a valuable enhancement to the mail-imap-mcp server, enabling users to access attachment content directly within their workflows. The implementation prioritizes:

- **Performance**: Opt-in design and size limits
- **Reliability**: Graceful error handling
- **Safety**: Input validation and resource management
- **Usability**: Clear parameters and documentation

The feature is production-ready for common use cases (invoices, reports, contracts) while acknowledging limitations (OCR, complex layouts) that can be addressed in future iterations.

## References

- [pdf-parse Library](https://github.com/mehmet-kozan/pdf-parse)
- [IMAP Flow Documentation](https://imapflow.com/)
- [Zod Validation](https://zod.dev/)
- [MCP Protocol](https://modelcontextprotocol.io/)
