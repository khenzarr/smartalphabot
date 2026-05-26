import { pathToFileURL } from 'node:url';
import { buildWatchlistQualityReport, writeWatchlistMetadata, writeWatchlistQualityArtifacts } from '../monitoring/watchlist-quality.js';
import { parseBooleanFlagArg } from '../utils/cli-boolean.js';

function parseArgs(argv: string[]) {
  const writeMetadata = parseBooleanFlagArg(argv, 'write-metadata', false);
  return { writeMetadata };
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const report = await buildWatchlistQualityReport();
  await writeWatchlistQualityArtifacts(report);
  if (args.writeMetadata) {
    await writeWatchlistMetadata({ report });
  }

  console.log('Watchlist quality summary');
  console.log(`- runAt: ${report.runAt}`);
  console.log(`- totalWatchedWallets: ${report.totalWatchedWallets}`);
  console.log(`- active_alpha: ${report.counts.active_alpha}`);
  console.log(`- active_watch: ${report.counts.active_watch}`);
  console.log(`- stale: ${report.counts.stale}`);
  console.log(`- noisy: ${report.counts.noisy}`);
  console.log(`- unknown: ${report.counts.unknown}`);
  console.log(`- metadataWritten: ${args.writeMetadata}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
