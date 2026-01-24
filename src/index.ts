#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { start } from './startup.js';

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
  start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Fatal error: ${message}`);
    process.exitCode = 1;
  });
}
