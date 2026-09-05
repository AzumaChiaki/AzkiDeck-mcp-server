import { readFileSync } from 'node:fs';

// This relative path works from both src/ (tsx) and dist/ (release bundles).
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
export const SERVER_VERSION = metadata.version;
