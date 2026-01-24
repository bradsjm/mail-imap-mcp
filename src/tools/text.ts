export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trim()}…`;
}

export function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}
