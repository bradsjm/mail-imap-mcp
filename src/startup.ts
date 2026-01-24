import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { createServer } from './server.js';
import { validateEnvironment } from './config.js';

export async function start(): Promise<void> {
  dotenv.config({ quiet: true });
  const errors = validateEnvironment();
  if (errors.length > 0) {
    console.error('mail-imap-mcp startup failed due to missing configuration:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    console.error(
      'Set required variables (HOST/USER/PASS) for each account and retry. See README.md for details.',
    );
    process.exitCode = 1;
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mail-imap-mcp running on stdio');
}
