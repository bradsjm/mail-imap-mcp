import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './contracts.js';
import { WRITE_ENABLED } from './config.js';
import { WRITE_TOOLS } from './policy.js';
import { handleToolCall } from './handler.js';

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'mail-imap-mcp', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const available: readonly ToolDefinition[] = TOOL_DEFINITIONS.filter((tool) => {
    if (WRITE_ENABLED) {
      return true;
    }
    return !WRITE_TOOLS.has(tool.name);
  });

  for (const tool of available) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      async (args) => handleToolCall(tool.name, args),
    );
  }

  return server;
}
