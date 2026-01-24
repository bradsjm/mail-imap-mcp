import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { createServer } from './server.js';
import { validateEnvironment } from './config.js';

/**
 * Start the MCP server and begin processing IMAP email operations.
 *
 * This is the main entry point for the server. It performs the following steps:
 * 1. Loads environment variables from .env file (if present)
 * 2. Validates that all required IMAP account configurations are present
 * 3. Creates and configures the MCP server instance
 * 4. Connects the server to the stdio transport for communication with the MCP client
 * 5. Logs that the server is running (to stderr for structured logging)
 *
 * If configuration validation fails, detailed error messages are printed to stderr
 * and the process exits with code 1. Otherwise, the server runs indefinitely
 * until the MCP client closes the connection.
 *
 * @throws Never intentionally - errors are caught and logged to stderr before exit
 */
export async function start(): Promise<void> {
  // Load environment variables from .env file (if present)
  // The quiet option prevents warnings when the .env file is missing
  dotenv.config({ quiet: true });

  // Validate that all required environment variables are configured
  // This ensures we have at least one complete IMAP account configuration
  const errors = validateEnvironment();
  if (errors.length > 0) {
    // Configuration is invalid - print detailed error messages and exit
    console.error('mail-imap-mcp startup failed due to missing configuration:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    console.error(
      'Set required variables (HOST/USER/PASS) for each account and retry. See README.md for details.',
    );
    // Set non-zero exit code to indicate failure
    process.exitCode = 1;
    return;
  }

  // Create the MCP server with all tool definitions registered
  const server = createServer();

  // Create a stdio transport for communication with the MCP client
  // This is the standard transport for MCP servers running as subprocesses
  const transport = new StdioServerTransport();

  // Connect the server to the transport and start processing requests
  await server.connect(transport);

  // Log to stderr (not stdout) to avoid interfering with MCP protocol communication
  // This message confirms the server is ready to handle tool calls
  console.error('mail-imap-mcp running on stdio');
}
