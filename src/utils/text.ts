/**
 * Truncate a string to a maximum length, adding an ellipsis if truncated.
 *
 * Shortens the input string to at most `maxChars` characters. If the string
 * exceeds this limit, it is cut at the boundary, trailing whitespace is removed,
 * and an ellipsis (…) is appended to indicate truncation.
 *
 * @example
 * ```ts
 * truncateText('Hello world', 5);  // Returns: 'Hello…'
 * truncateText('Hello world', 20); // Returns: 'Hello world' (no truncation)
 * truncateText('  spaced  ', 5);   // Returns: 'space…' (trim removes trailing space before ellipsis)
 * ```
 *
 * @param value - The string to truncate
 * @param maxChars - The maximum number of characters to return (before adding ellipsis)
 * @returns The truncated string, with ellipsis if it was shortened
 */
export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trim()}…`;
}

/**
 * Normalize whitespace in a string by collapsing multiple whitespace characters.
 *
 * Converts all sequences of whitespace characters (spaces, tabs, newlines, etc.)
 * into single spaces and trims leading/trailing whitespace. This is useful for
 * cleaning up text that may have irregular formatting, such as HTML content
 * converted to plain text.
 *
 * @example
 * ```ts
 * normalizeWhitespace('Hello   world');  // Returns: 'Hello world'
 * normalizeWhitespace('  spaced\tout\n'); // Returns: 'spaced out'
 * normalizeWhitespace('already clean');   // Returns: 'already clean'
 * ```
 *
 * @param value - The string to normalize
 * @returns A string with all whitespace sequences collapsed to single spaces and trimmed
 */
export function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}
