import { z } from 'zod';
import { normalizeSeedFile, writeNormalizedSeeds } from '../discovery/seed-expansion.js';

const schema = z.object({
  input: z.string().min(1),
  out: z.string().min(1),
  'default-narrative': z.string().optional(),
});

function parseArgs() {
  const args = process.argv.slice(2);
  const map: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]?.startsWith('--')) map[args[i].slice(2)] = args[i + 1];
  }
  return schema.parse(map);
}

async function main() {
  const input = parseArgs();
  const result = await normalizeSeedFile(input.input, input['default-narrative']);
  await writeNormalizedSeeds(input.out, result);

  console.log('=== Seeds Normalize Summary ===');
  console.log(`Input: ${input.input}`);
  console.log(`Output: ${input.out}`);
  console.log(`Input Count: ${result.summary.inputCount}`);
  console.log(`Invalid Count: ${result.summary.invalidCount}`);
  console.log(`Duplicate Count: ${result.summary.duplicateCount}`);
  console.log(`Output Count: ${result.summary.outputCount}`);
  if (result.warnings.length) {
    console.log('Warnings:');
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
