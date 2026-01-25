#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { start } from './startup.js';
import { getHelpText } from './help.js';

export { getListedTools } from './handler.js';
export { scrubSecrets } from './logging.js';
export { validateEnvironment } from './config.js';

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === entry;
}

if (isEntrypoint()) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    dotenv.config({ quiet: true });
    console.log(getHelpText());
  } else {
    start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Fatal error: ${message}`);
      process.exitCode = 1;
    });
  }
}
