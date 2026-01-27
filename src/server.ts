import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './contracts.js';
import { handleToolCall } from './handler.js';
import { getAvailableTools } from './utils/tools.js';
import { registerImapResources } from './resources/imap_resources.js';
import { registerPhishingPrompts } from './prompts/phishing_prompts.js';
import { registerClassificationPrompts } from './prompts/classification_prompts.js';

/**
 * Create and configure an MCP server for IMAP email operations.
 *
 * Initializes a new Model Context Protocol server with the mail-imap-mcp
 * capabilities, registers all available IMAP tools, and sets up the routing
 * from tool calls to their respective handler functions.
 *
 * The server is configured with:
 * - A static name and version identifier
 * - Tool capabilities for email operations (list, search, get, move, delete, etc.)
 * - Write-operation filtering based on environment configuration
 *
 * @returns A configured McpServer instance ready to be connected to a transport
 */
export function createServer(): McpServer {
  // Initialize the MCP server with metadata and capabilities
  // The capabilities object declares what features this server supports
  const server = new McpServer(
    { name: 'mail-imap-mcp', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Filter tool definitions based on write-enable policy
  // If MAIL_IMAP_WRITE_ENABLED is false, write operations (move, delete, flag updates) are excluded
  const available: readonly ToolDefinition[] = getAvailableTools(TOOL_DEFINITIONS);

  // Register each available tool with the server
  // This creates the mapping between tool names and their handler functions
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

  // Resources are additive and optional: tool-only clients keep full functionality.
  // Clients that support MCP resources can attach message/attachment URIs as context.
  registerImapResources(server);
  registerPhishingPrompts(server);
  registerClassificationPrompts(server);

  return server;
}
