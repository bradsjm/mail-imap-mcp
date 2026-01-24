import type { ToolDefinition } from '../contracts.js';
import { WRITE_ENABLED } from '../config.js';
import { WRITE_TOOLS } from '../policy.js';

/**
 * Filter tool definitions by write-enable policy.
 */
export function getAvailableTools(tools: readonly ToolDefinition[]): readonly ToolDefinition[] {
  if (WRITE_ENABLED) {
    return tools;
  }
  return tools.filter((tool) => !WRITE_TOOLS.has(tool.name));
}
