import { runSync } from './worker.mjs';

// The host supplies secrets through the process environment, never CLI arguments.
const result = await runSync({
  SITE_ORIGIN: process.env.SITE_ORIGIN,
  SYNC_SECRET: process.env.SYNC_SECRET,
  MEDIA_PASSES: process.env.MEDIA_PASSES,
});

process.exitCode = result.outcome === 'error' ? 1 : result.outcome === 'partial' ? 2 : 0;
