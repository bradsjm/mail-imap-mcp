import { randomUUID } from 'node:crypto';

/**
 * Represents a contiguous range of IMAP message UIDs.
 *
 * UIDs in IMAP are monotonically increasing integers. When we have many matching
 * messages, we can compress them into ranges to save memory. For example, UIDs
 * [100, 101, 102, 105, 106] would be represented as two ranges: {100-102} and {105-106}.
 *
 * Ranges are always stored in ascending order (min <= max).
 */
export type UidRange = Readonly<{
  /** The minimum UID value in the range (inclusive) */
  min: number;
  /** The maximum UID value in the range (inclusive) */
  max: number;
}>;

export type SearchCursor = Readonly<{
  /** Unique identifier for this cursor, used for pagination */
  id: string;
  /** The tool that created this cursor (always 'imap_search_messages') */
  tool: 'imap_search_messages';
  /** The IMAP account identifier for this search */
  account_id: string;
  /** The mailbox being searched */
  mailbox: string;
  /** The UIDVALIDITY of the mailbox when the search was performed */
  uidvalidity: number;
  /** Compressed UID ranges of all matching messages, sorted in descending order */
  uid_ranges: readonly UidRange[];
  /** Current offset into the results (how many messages have been returned) */
  offset: number;
  /** Total number of messages matching the search */
  total: number;
  /** Whether message snippets should be included in results */
  include_snippet: boolean;
  /** Maximum number of characters to include in each snippet */
  snippet_max_chars: number;
  /** Unix timestamp (ms) when this cursor was created */
  created_at_ms: number;
  /** Unix timestamp (ms) when this cursor expires and should be removed */
  expires_at_ms: number;
}>;

export type CursorStoreOptions = Readonly<{
  /** Time-to-live for cursors in milliseconds before they expire */
  ttl_ms: number;
  /** Maximum number of cursors to store; oldest are evicted when exceeded */
  max_entries: number;
}>;

/**
 * Convert a sorted array of UIDs into compressed ranges.
 *
 * This function takes an array of UIDs that should already be sorted in
 * descending order and compresses consecutive UIDs into ranges. For example,
 * [10, 9, 8, 5, 4] becomes [{10-8}, {5-4}]. This compression is essential
 * for memory efficiency when dealing with large search results.
 *
 * The algorithm walks through the sorted UIDs, tracking the current range.
 * When a gap is detected (UID != currentMin - 1), the current range is
 * finalized and a new one is started.
 *
 * @example
 * ```ts
 * uidsToDescendingRanges([10, 9, 8, 5, 4]);
 * // Returns: [{ min: 8, max: 10 }, { min: 4, max: 5 }]
 * ```
 *
 * @param uidsDesc - Array of UIDs sorted in descending order
 * @returns Array of compressed ranges, also in descending order
 */
export function uidsToDescendingRanges(uidsDesc: readonly number[]): UidRange[] {
  if (uidsDesc.length === 0) {
    return [];
  }

  const ranges: UidRange[] = [];
  let currentMin = uidsDesc[0] ?? 0;
  let currentMax = currentMin;

  // Iterate through UIDs looking for consecutive sequences
  // Since UIDs are descending, consecutive means each next UID is currentMin - 1
  for (let index = 1; index < uidsDesc.length; index += 1) {
    const uid = uidsDesc[index];
    if (uid === undefined) {
      continue;
    }
    // If this UID continues the current range, extend it downward
    if (uid === currentMin - 1) {
      currentMin = uid;
      continue;
    }
    // Gap detected: finalize current range and start a new one
    ranges.push({ min: currentMin, max: currentMax });
    currentMin = uid;
    currentMax = uid;
  }

  // Don't forget to add the last range
  ranges.push({ min: currentMin, max: currentMax });
  return ranges;
}

/**
 * Calculate the total number of messages represented by a list of UID ranges.
 *
 * @example
 * ```ts
 * totalFromRanges([{ min: 1, max: 5 }, { min: 10, max: 12 }]);
 * // Returns: 8 (5 from first range + 3 from second)
 * ```
 *
 * @param ranges - Array of UID ranges
 * @returns Total count of messages across all ranges
 */
export function totalFromRanges(ranges: readonly UidRange[]): number {
  return ranges.reduce((sum, range) => sum + (range.max - range.min + 1), 0);
}

/**
 * Extract a slice of UIDs from compressed ranges, handling offset and limit.
 *
 * This function implements pagination by extracting a subset of UIDs from
 * ranges while maintaining descending order. It handles the offset by skipping
 * the appropriate number of UIDs before collecting results.
 *
 * The algorithm works by:
 * 1. Skipping UIDs from each range based on the offset
 * 2. Once we've skipped enough, collecting UIDs starting from the end (highest)
 * 3. Moving backward through the range to maintain descending order
 * 4. Moving to the next range if we exhaust the current one
 *
 * @example
 * ```ts
 * // Given ranges [{10-8}, {5-4}], offset=2, limit=3
 * // Skip first 2 UIDs (10, 9), then take next 3: [8, 5, 4]
 * sliceUidsFromDescendingRanges([{min: 8, max: 10}, {min: 4, max: 5}], 2, 3);
 * // Returns: [8, 5, 4]
 * ```
 *
 * @param ranges - Array of UID ranges in descending order
 * @param offset - Number of UIDs to skip from the start
 * @param limit - Maximum number of UIDs to return
 * @returns Array of UIDs in descending order, respecting offset and limit
 */
export function sliceUidsFromDescendingRanges(
  ranges: readonly UidRange[],
  offset: number,
  limit: number,
): number[] {
  if (limit <= 0) {
    return [];
  }
  if (offset < 0) {
    return [];
  }

  let remainingSkip = offset;
  const uids: number[] = [];

  // Walk through each range, skipping UIDs based on offset, then collecting
  for (const range of ranges) {
    const rangeCount = range.max - range.min + 1;
    // Skip entire range if we haven't skipped enough yet
    if (remainingSkip >= rangeCount) {
      remainingSkip -= rangeCount;
      continue;
    }

    // Start from the end of the range (max UID), accounting for skip offset
    // We go backward to maintain descending order
    let uid = range.max - remainingSkip;
    remainingSkip = 0;
    while (uid >= range.min && uids.length < limit) {
      uids.push(uid);
      uid -= 1;
    }
    // Stop if we've collected enough UIDs
    if (uids.length >= limit) {
      break;
    }
  }

  return uids;
}

/**
 * Thread-safe in-memory store for managing search pagination cursors.
 *
 * This class provides a storage mechanism for search cursors that supports:
 * - Creating cursors with automatic expiration (TTL)
 * - Retrieving cursors with expiration checking
 * - Updating cursor state (e.g., advancing the offset)
 * - Automatic cleanup of expired cursors
 * - LRU-style eviction when the maximum entry count is exceeded
 *
 * The store is designed to be used with the search_messages tool to implement
 * server-side pagination while keeping memory usage bounded.
 *
 * Note: This implementation is not truly thread-safe across multiple Node.js
 * worker threads, but is safe for single-threaded async operations.
 */
export class CursorStore {
  /** Internal map storing all active cursors, keyed by their unique ID */
  private readonly entries = new Map<string, SearchCursor>();
  /** Time-to-live for new cursors in milliseconds */
  private readonly ttlMs: number;
  /** Maximum number of cursors to store before evicting old ones */
  private readonly maxEntries: number;

  constructor(options: CursorStoreOptions) {
    this.ttlMs = options.ttl_ms;
    this.maxEntries = options.max_entries;
  }

  /**
   * Create a new search cursor from the provided data.
   *
   * Generates a unique ID for the cursor, sets timestamps for creation and
   * expiration, performs cleanup of any expired cursors, and enforces the
   * maximum entry limit before storing.
   *
   * @param input - The cursor data excluding auto-generated fields (id, timestamps)
   * @returns The newly created and stored cursor
   */
  createSearchCursor(
    input: Omit<SearchCursor, 'id' | 'created_at_ms' | 'expires_at_ms'>,
  ): SearchCursor {
    const now = Date.now();
    const cursor: SearchCursor = {
      ...input,
      id: randomUUID(),
      created_at_ms: now,
      expires_at_ms: now + this.ttlMs,
    };
    this.entries.set(cursor.id, cursor);
    this.cleanup(now);
    this.enforceLimit();
    return cursor;
  }

  /**
   * Retrieve a cursor by ID, checking that it hasn't expired.
   *
   * Returns null if the cursor doesn't exist or has already expired. This
   * method also triggers cleanup of any other expired cursors to keep the
   * store clean.
   *
   * @param id - The unique identifier of the cursor to retrieve
   * @returns The cursor if found and not expired, or null otherwise
   */
  getSearchCursor(id: string): SearchCursor | null {
    const now = Date.now();
    this.cleanup(now);
    const cursor = this.entries.get(id);
    if (!cursor) {
      return null;
    }
    if (cursor.expires_at_ms <= now) {
      this.entries.delete(id);
      return null;
    }
    return cursor;
  }

  /**
   * Update the offset of an existing cursor.
   *
   * This is used when advancing through paginated results. The cursor is
   * retrieved (with expiration check), its offset is updated, and it's
   * stored back in the map. Returns null if the cursor doesn't exist or
   * has expired.
   *
   * @param id - The unique identifier of the cursor to update
   * @param offset - The new offset value to set
   * @returns The updated cursor, or null if not found or expired
   */
  updateSearchCursor(id: string, offset: number): SearchCursor | null {
    const cursor = this.getSearchCursor(id);
    if (!cursor) {
      return null;
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > cursor.total) {
      this.entries.delete(id);
      return null;
    }
    const updated: SearchCursor = { ...cursor, offset };
    this.entries.set(id, updated);
    return updated;
  }

  /**
   * Manually delete a cursor from the store.
   *
   * This is typically called when a user reaches the end of pagination
   * or when an error occurs and the cursor should be invalidated.
   *
   * @param id - The unique identifier of the cursor to delete
   */
  delete(id: string): void {
    this.entries.delete(id);
  }

  /**
   * Remove all expired cursors from the store.
   *
   * Iterates through all entries and removes any that have an expiration
   * timestamp before the current time. This is called automatically by
   * getSearchCursor and createSearchCursor to keep memory usage bounded.
   *
   * @param now - The current time in milliseconds (for testing consistency)
   */
  private cleanup(now: number): void {
    for (const [id, entry] of this.entries.entries()) {
      if (entry.expires_at_ms <= now) {
        this.entries.delete(id);
      }
    }
  }

  /**
   * Enforce the maximum entry limit by evicting the oldest cursors.
   *
   * If the number of stored cursors exceeds maxEntries, this method removes
   * the oldest entries (by creation time) until the limit is satisfied.
   * This implements an LRU (Least Recently Used) eviction policy based on
   * creation time rather than access time.
   *
   * Note: This is O(n log n) due to sorting, but is only called when the
   * limit is exceeded, not on every operation.
   */
  private enforceLimit(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    // Sort entries by creation time (oldest first) to identify eviction candidates
    const sorted = [...this.entries.values()].sort((a, b) => a.created_at_ms - b.created_at_ms);
    const excess = sorted.length - this.maxEntries;
    // Remove the oldest entries to bring us back under the limit
    for (let i = 0; i < excess; i += 1) {
      const entry = sorted[i];
      if (entry) {
        this.entries.delete(entry.id);
      }
    }
  }
}
