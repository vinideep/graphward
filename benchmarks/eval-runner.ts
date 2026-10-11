/** Gate 6 consumes measured held-out runs; synthetic outcomes cannot qualify a release. */
import { main } from '../scripts/evaluate-agent-runs.mjs';
export { runEndToEndBenchmark } from '../scripts/evaluate-agent-runs.mjs';
if (process.argv[1]?.endsWith('eval-runner.ts')) await main();
