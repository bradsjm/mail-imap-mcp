import { PDFParse } from 'pdf-parse';

/**
 * Extract plain text from a PDF document.
 *
 * Parses a PDF buffer and extracts all text content, converting it to a
 * readable string. This function handles various PDF formats and encoding
 * schemes, attempting to extract text in a usable form.
 *
 * The PDF parsing process:
 * 1. Creates a PDFParse parser instance with the buffer data
 * 2. Executes the text extraction, which handles PDF-specific challenges:
 *    - Character encoding (various PDF fonts and encodings)
 *    - Text positioning and layout (reading order)
 *    - Embedded fonts and character mapping
 * 3. Cleans up parser resources to prevent memory leaks
 * 4. Returns the extracted text, or null if no text was found
 *
 * Error handling:
 * - Corrupted or invalid PDFs return null (logged to stderr)
 * - Password-protected PDFs return null (logged to stderr)
 * - PDFs with complex layouts may have suboptimal text ordering
 * - Images and non-text elements are ignored
 *
 * Performance considerations:
 * - This operation can be CPU-intensive for large PDFs
 * - Memory usage scales with PDF size
 * - Consider caching results for frequently accessed PDFs
 *
 * @example
 * ```/dev/null/pdf-example.ts
 * import { readFile } from 'node:fs/promises';
 *
 * const pdfBuffer = await readFile('document.pdf');
 * const text = await extractTextFromPdf(pdfBuffer);
 *
 * if (text) {
 *   console.log('Extracted text:', text);
 * } else {
 *   console.log('No text could be extracted');
 * }
 * ```
 *
 * @param buffer - A Buffer containing the raw PDF file data
 * @returns The extracted text as a string, or null if extraction failed or no text was found
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string | null> {
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
