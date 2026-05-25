import { parseBooleanEnvValue } from '../config/env.js';

export function parseBooleanFlagArg(argv: string[], name: string, fallback = false): boolean {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const raw = argv[i + 1];
  if (raw === undefined || raw.startsWith('--')) return true;
  return parseBooleanEnvValue(raw, fallback);
}
