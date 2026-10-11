import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Consume measured, paired held-out runs. This function never invents outcomes. */
export async function runEndToEndBenchmark(records = []) {
  const failures = [];
  if (!Array.isArray(records) || !records.length) return { status: 'unavailable', passed: false, capabilities: [], ablations: [], netImprovementPct: null, regressionEscapeRate: null, failures: ['No measured agent runs supplied.'] };
  const keys = new Set();
  const groups = new Map();
  for (const run of records) {
    if (!run || run.evidence !== 'measured' || run.heldOut !== true || !['baseline', 'graphward'].includes(run.configuration) || !['taskId', 'repository', 'sourceRevision', 'model', 'modelVersion', 'requestHash', 'candidateHash'].every(key => typeof run[key] === 'string' && run[key].trim()) || !Array.isArray(run.checks) || !run.checks.length || !run.checks.every(check => check && typeof check.command === 'string' && check.command.trim() && Number.isInteger(check.exitCode) && typeof check.timedOut === 'boolean') || !['regressions', 'requiredChangesMissed', 'unnecessaryChanges', 'clarificationErrors', 'relevantContextMissed', 'latencyMs', 'cost'].every(key => Number.isFinite(run[key]) && run[key] >= 0)) {
      failures.push('Run lacks measured checks, fixed identities, held-out status, or accuracy/cost metrics.'); continue;
    }
    const pair = JSON.stringify([run.taskId, run.repository, run.sourceRevision, run.model, run.modelVersion, run.requestHash, run.candidateHash]);
    const key = `${pair}:${run.configuration}`;
    if (keys.has(key)) { failures.push('Duplicate run identity.'); continue; }
    keys.add(key); const group = groups.get(pair) ?? {}; group[run.configuration] = run; groups.set(pair, group);
  }
  const paired = [...groups.values()].filter(group => group.baseline && group.graphward);
  if (paired.length !== groups.size) failures.push('Unmatched baseline and GraphWard identities.');
  if (new Set(paired.map(group => group.graphward.repository)).size < 2) failures.push('Held-out qualification requires multiple repositories.');
  const resolved = run => run.checks.every(check => check.exitCode === 0 && !check.timedOut) && ['regressions', 'requiredChangesMissed', 'unnecessaryChanges', 'clarificationErrors', 'relevantContextMissed'].every(key => run[key] === 0);
  const ablations = ['baseline', 'graphward'].map(configuration => ({ configuration, tasksAttempted: paired.length, tasksResolved: paired.filter(pair => resolved(pair[configuration])).length, regressionsIntroduced: paired.reduce((sum, pair) => sum + pair[configuration].regressions, 0), metrics: Object.fromEntries(["regressions", "requiredChangesMissed", "unnecessaryChanges", "clarificationErrors", "relevantContextMissed", "latencyMs", "cost"].map(metric => [metric, paired.length ? paired.reduce((sum, pair) => sum + pair[configuration][metric], 0) / paired.length : null])) }));
  const improvement = paired.length ? 100 * (ablations[1].tasksResolved - ablations[0].tasksResolved) / paired.length : null;
  const regressionRate = paired.length ? 100 * paired.filter(pair => pair.graphward.regressions > 0).length / paired.length : null;
  if (improvement === null || regressionRate === null) failures.push('No valid paired runs.');
  if (improvement !== null && improvement < 20) failures.push('Measured improvement is below the 20 percentage-point release threshold.');
  if (regressionRate !== null && regressionRate > 2) failures.push('Measured regression escape rate exceeds 2 percent.');
  return { status: failures.length ? 'failed' : 'measured', passed: !failures.length, capabilities: [], ablations, netImprovementPct: improvement, regressionEscapeRate: regressionRate, failures };
}
export async function main() {
  const index = process.argv.indexOf('--results');
  const result = await runEndToEndBenchmark(index >= 0 ? JSON.parse(await readFile(process.argv[index + 1], 'utf8')) : []);
  console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
