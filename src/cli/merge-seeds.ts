import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { mergeSeedFiles } from '../discovery/seed-expansion.js';
import { safeJsonStringify } from '../utils/json.js';

const schema = z.object({
  base: z.string().min(1),
  add: z.string().min(1),
  out: z.string().min(1),
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
  const result = await mergeSeedFiles(input.base, input.add);
  await writeFile(input.out, safeJsonStringify(result.seeds, 2), 'utf8');
  await writeFile(
    input.out.replace(/\.json$/i, '.meta.json'),
    safeJsonStringify(
      {
        generatedAt: new Date().toISOString(),
        baseFile: input.base,
        addFile: input.add,
        outputFile: input.out,
        summary: result.summary,
      },
      2,
    ),
    'utf8',
  );

  console.log('=== Seeds Merge Summary ===');
  console.log(`Base: ${input.base}`);
  console.log(`Add: ${input.add}`);
  console.log(`Output: ${input.out}`);
  console.log(`Base Count: ${result.summary.baseCount}`);
  console.log(`Add Count: ${result.summary.addCount}`);
  console.log(`Duplicate Count: ${result.summary.duplicateCount}`);
  console.log(`Final Count: ${result.summary.finalCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
