import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evaluateEfficiencyRuns, efficiencySpecHash, usageFromTelemetry } from '../scripts/evaluate-efficiency-runs.mjs';
import { recordFromTranscript } from '../dist/telemetry/index.js';

const hash = character => character.repeat(64);
const identity = taskId => ({ taskId, repository: 'fixture-repository', sourceRevision: 'fixed-source', model: 'configured-model', modelVersion: 'fixed-version', requestHash: hash('a'), seed: 42 });
const metric = value => ({ availability: value === null ? 'unavailable' : 'available', value });
const usage = (value = 10) => ({ accounting: 'disjoint', scope: 'complete', categories: Object.fromEntries(['uncachedInput', 'cacheWrite', 'cacheRead', 'output'].map(category => [category, { availability: 'available', tokens: value }])) });
const attempt = (id, value = 10) => ({ id, kind: 'initial', status: 'succeeded', usage: usage(value), cost: { ...metric(0.01), currency: 'USD' } });
function specification() {
  return {
    schemaVersion: 1, experimentId: 'fixture', frozen: true, stage: 'development',
    preregisteredAt: '2026-10-01T00:00:00Z', collectionStartsAt: '2026-10-02T00:00:00Z',
    arms: ['baseline', 'current', 'simplified'], repetitions: 1,
    armArtifacts: { baseline: hash('b'), current: hash('c'), simplified: hash('d') },
    conditions: { host: 'fixture-host', hostVersion: 'fixed', toolPolicyHash: hash('e'), maxTokens: 5000, maxDurationMs: 60000, temperature: 0 },
    tasks: ['development', 'held-out'].map(split => ({ ...identity(split), split, checks: [{ id: 'test', command: 'node --test actual-test.mjs' }] })),
    heldOutPlan: { taskCount: 1, repetitions: 3, selectionHash: hash('f'), sizeJustification: 'Synthetic fixture only; no statistical power assertion.', analysisUnit: 'task', blindedReestimation: null },
    decisionPolicy: { tokenReductionTargetPct: 25, acceptancePolicy: 'no-decrease', purpose: 'descriptive-only' },
  };
}
function record(spec, arm, task = spec.tasks[0], repetition = 1) {
  return {
    schemaVersion: 1, evidence: 'measured', experimentId: spec.experimentId, specHash: efficiencySpecHash(spec), stage: spec.stage,
    ...Object.fromEntries(['taskId', 'repository', 'sourceRevision', 'model', 'modelVersion', 'requestHash', 'seed'].map(field => [field, task[field]])), arm, repetition, artifactHash: spec.armArtifacts[arm], conditions: structuredClone(spec.conditions),
    startedAt: '2026-10-03T00:00:00Z', completedAt: '2026-10-03T00:00:01Z',
    checks: [{ id: 'test', command: 'node --test actual-test.mjs', exitCode: 0, timedOut: false, evidenceHash: hash('1') }],
    outcome: { accepted: true, regressions: 0, requiredChangesMissed: 0, unnecessaryChanges: 0, clarificationErrors: 0, relevantContextMissed: 0, evidenceHash: hash('2') },
    attempts: [attempt(`${arm}-${task.taskId}-${repetition}`)],
    attemptsAccountingComplete: true,
    maintenance: { accountingComplete: true, evidenceHash: hash('3'), items: [] }, latencyMs: metric(1000),
  };
}
const runs = spec => spec.arms.flatMap(arm => spec.tasks.filter(task => task.split === (spec.stage === 'held-out' ? 'held-out' : 'development')).flatMap(task => Array.from({ length: spec.repetitions }, (_, index) => record(spec, arm, task, index + 1))));

test('three fixed task arms pair independently of their different artifact hashes', () => {
  const spec = specification();
  const result = evaluateEfficiencyRuns(spec, runs(spec));
  assert.equal(result.measurementComplete, true);
  assert.equal(result.pairedTaskRuns, 1);
  assert.equal(result.releaseQualification, false);
  assert.equal(result.improvementClaim, false);
  assert.equal(result.arms.current.tokens.perAcceptedTask, 40);
});

test('missing or duplicate arms and any fixed-condition mismatch prevent complete comparisons', () => {
  const spec = specification();
  const original = runs(spec);
  const invalid = [original.slice(0, 2), [...original, original[0]]];
  for (const field of ['taskId', 'repository', 'sourceRevision', 'model', 'modelVersion', 'requestHash', 'seed', 'repetition', 'artifactHash', 'specHash', 'stage']) {
    const changed = structuredClone(original);
    changed[1][field] = typeof changed[1][field] === 'number' ? 999 : 'different';
    invalid.push(changed);
  }
  const changedConditions = structuredClone(original); changedConditions[1].conditions.maxTokens++;
  invalid.push(changedConditions);
  for (const input of invalid) {
    const result = evaluateEfficiencyRuns(spec, input);
    assert.equal(result.measurementComplete, false);
    assert.equal(result.comparisons.every(comparison => comparison.tokenReductionPct === null), true);
    assert.ok(result.failures.length);
    assert.equal(result.releaseQualification, false);
  }
});

test('only frozen preregistration and measured checks/outcomes are accepted', () => {
  const spec = specification();
  for (const mutate of [
    records => { records[0].evidence = 'simulated'; },
    records => { records[0].checks = []; },
    records => { records[0].checks[0].command = 'different check'; },
    records => { records[0].checks[0].evidenceHash = ''; },
    records => { records[0].outcome.regressions = -1; },
    records => { records[0].outcome.accepted = true; records[0].checks[0].exitCode = 1; },
    records => { records[0].startedAt = '2026-09-01T00:00:00Z'; },
  ]) {
    const records = runs(spec); mutate(records);
    assert.equal(evaluateEfficiencyRuns(spec, records).measurementComplete, false);
  }
  const unfrozen = { ...spec, frozen: false };
  assert.equal(evaluateEfficiencyRuns(unfrozen, runs(unfrozen)).measurementComplete, false);
  assert.equal(evaluateEfficiencyRuns(null).measurementComplete, false);
  assert.equal(evaluateEfficiencyRuns(spec).measurementComplete, false);
});

test('all failed tasks, retry/repair attempts, and maintenance are charged per accepted task', () => {
  const spec = specification();
  spec.tasks.splice(1, 0, { ...spec.tasks[0], ...identity('second') });
  const records = runs(spec);
  records[0].outcome.accepted = false; records[0].outcome.requiredChangesMissed = 1;
  records[0].attempts[0].status = 'failed';
  records[0].attempts.push({ ...attempt('baseline-retry', 20), kind: 'repair', status: 'failed' });
  records[0].maintenance.items.push({ id: 'baseline-maintenance', usage: usage(5), cost: { ...metric(0.02), currency: 'USD' } });
  const result = evaluateEfficiencyRuns(spec, records);
  assert.equal(result.measurementComplete, true);
  assert.equal(result.arms.baseline.tasksAccepted, 1);
  assert.equal(result.arms.baseline.attempts, 3);
  assert.equal(result.arms.baseline.maintenanceItems, 1);
  assert.equal(result.arms.baseline.tokens.total, 180);
  assert.equal(result.arms.baseline.tokens.perAcceptedTask, 180);
  assert.equal(result.arms.current.tokens.perAcceptedTask, 40);
  assert.equal(result.arms.baseline.cost.total, 0.05);
  assert.equal(result.improvementClaim, false);
});

test('missing, duplicated, overlapping, or partial usage cannot establish complete measurement', () => {
  const spec = specification();
  for (const mutate of [
    records => { records[0].attemptsAccountingComplete = false; },
    records => { records[0].attempts = []; },
    records => { records[0].attempts[0].usage = null; },
    records => { delete records[0].attempts[0].usage.categories.cacheWrite; },
    records => { records[0].attempts[0].usage.categories.cacheRead = { availability: 'unavailable', tokens: null }; },
    records => { records[0].attempts[0].usage.scope = 'partial'; },
    records => { records[0].attempts[0].usage.totalTokens = 40; },
    records => { records[0].attempts[0].usage.accounting = 'inclusive'; },
    records => { records[0].attempts.push(structuredClone(records[0].attempts[0])); },
    records => { records[0].maintenance.accountingComplete = false; },
    records => { records[0].maintenance.items.push(structuredClone(records[0].attempts[0])); },
  ]) {
    const records = runs(spec); mutate(records);
    const result = evaluateEfficiencyRuns(spec, records);
    assert.equal(result.measurementComplete, false);
    assert.equal(result.comparisons[0].tokenReductionPct, null);
    assert.equal(result.arms.baseline.tokens.total, null);
  }
});

test('zero accepted denominator and zero baseline tokens stay undefined without inventing savings', () => {
  const spec = specification(); const records = runs(spec);
  for (const run of records) { run.outcome.accepted = false; run.outcome.regressions = 1; }
  const result = evaluateEfficiencyRuns(spec, records);
  assert.equal(result.measurementComplete, true);
  assert.equal(result.arms.baseline.tokens.total, 40);
  assert.equal(result.arms.baseline.tokens.perAcceptedTask, null);
  assert.equal(result.arms.baseline.cost.perAcceptedTask, null);
  assert.equal(result.comparisons[0].tokenReductionPct, null);
  const emptyUsage = runs(spec); emptyUsage[0].attempts[0].usage = usage(0);
  assert.equal(evaluateEfficiencyRuns(spec, emptyUsage).comparisons[0].tokenReductionPct, null);
});

test('cost and elapsed latency are separately nullable and do not substitute for usage', () => {
  const spec = specification(); const records = runs(spec);
  records[0].attempts[0].cost = { ...metric(null), currency: null };
  records[0].latencyMs = metric(null);
  const result = evaluateEfficiencyRuns(spec, records);
  assert.equal(result.measurementComplete, true);
  assert.equal(result.arms.baseline.cost.available, false);
  assert.equal(result.arms.baseline.cost.total, null);
  assert.equal(result.arms.baseline.latencyMs.available, false);
  assert.equal(result.arms.baseline.latencyMs.total, null);
  assert.equal(result.arms.current.cost.available, true);
  assert.equal(result.arms.current.latencyMs.meanPerTaskRun, 1000);
});

test('108 directional pilot observations remain descriptive and never qualify a release', () => {
  const spec = specification(); spec.stage = 'directional-pilot'; spec.repetitions = 3;
  spec.tasks = [...Array.from({ length: 12 }, (_, index) => ({ ...spec.tasks[0], ...identity(`pilot-${index}`), repository: `pilot-repository-${index % 2}` })), spec.tasks[1]];
  const records = runs(spec);
  assert.equal(records.length, 108);
  const result = evaluateEfficiencyRuns(spec, records);
  assert.equal(result.measurementComplete, true);
  assert.equal(result.pairedTaskRuns, 36);
  assert.equal(result.releaseQualification, false);
  assert.equal(result.improvementClaim, false);
  const singleRepository = structuredClone(spec);
  for (const task of singleRepository.tasks) if (task.split === 'development') task.repository = 'only-one';
  assert.equal(evaluateEfficiencyRuns(singleRepository, runs(singleRepository)).measurementComplete, false);
  spec.repetitions = 2;
  assert.equal(evaluateEfficiencyRuns(spec, runs(spec)).measurementComplete, false);
});

test('telemetry adapter requires both complete accounting and complete authorized scope', () => {
  const sample = { accounting: { complete: true, totalTokens: 20, uncachedInputTokens: 10, cacheWriteTokens: 2, cacheReadTokens: 5, outputTokens: 3, availability: { uncachedInput: 'reported', cacheWrite: 'reported', cacheRead: 'reported', output: 'reported' } }, scope: { status: 'complete' } };
  assert.deepEqual(usageFromTelemetry(sample).categories.cacheWrite, { availability: 'available', tokens: 2 });
  assert.equal(usageFromTelemetry(sample).scope, 'complete');
  for (const incomplete of [{}, { ...sample, scope: { status: 'parent-only' } }, { ...sample, accounting: { ...sample.accounting, complete: false } }]) {
    assert.equal(usageFromTelemetry(incomplete).scope === 'complete', false);
    assert.equal(Object.values(usageFromTelemetry(incomplete).categories).some(category => category.tokens === null), true);
  }
  for (const totalTokens of [undefined, null, 21, Number.MAX_SAFE_INTEGER + 1]) assert.notEqual(usageFromTelemetry({ ...sample, accounting: { ...sample.accounting, totalTokens } }).scope, 'complete');
});

test('unsafe token category sums and unsafe disjoint totals invalidate complete measurement', () => {
  const spec = specification();
  for (const multipleItems of [false, true]) {
    const records = runs(spec);
    records[0].attempts[0].usage = usage(0);
    records[0].attempts[0].usage.categories.uncachedInput.tokens = Number.MAX_SAFE_INTEGER;
    if (multipleItems) records[0].attempts.push({ ...attempt('overflow-retry', 1), kind: 'retry' });
    else records[0].attempts[0].usage.categories.output.tokens = 1;
    const result = evaluateEfficiencyRuns(spec, records);
    assert.equal(result.measurementComplete, false);
    assert.equal(result.arms.baseline.tokens.total, null);
    assert.equal(result.comparisons[0].tokenReductionPct, null);
    if (multipleItems) assert.equal(result.arms.baseline.tokens.categories.uncachedInput.observedTokens, null);
  }
});

test('a task cannot cross frozen splits through a changed seed, and attempts must start once', () => {
  const spec = specification();
  const leaked = structuredClone(spec);
  leaked.tasks[1] = { ...leaked.tasks[0], split: 'held-out', seed: 999 };
  assert.equal(evaluateEfficiencyRuns(leaked, runs(leaked)).measurementComplete, false);
  for (const mutate of [
    records => { records[0].attempts[0].kind = 'retry'; },
    records => { records[0].attempts.push(attempt('second-initial')); },
  ]) {
    const records = runs(spec); mutate(records);
    assert.equal(evaluateEfficiencyRuns(spec, records).measurementComplete, false);
  }
});

test('distinct task counts cannot be inflated by seed, request, or model variants in any stage', () => {
  for (const stage of ['development', 'directional-pilot', 'held-out']) for (const field of ['seed', 'requestHash', 'model']) {
    const spec = specification(); spec.stage = stage;
    if (stage === 'directional-pilot') {
      spec.repetitions = 3;
      spec.tasks = [...Array.from({ length: 12 }, (_, index) => ({ ...spec.tasks[0], ...identity(`pilot-${index}`), repository: `repository-${index % 2}` })), spec.tasks[1]];
      spec.tasks[1] = structuredClone(spec.tasks[0]);
    } else {
      if (stage === 'held-out') spec.repetitions = spec.heldOutPlan.repetitions;
      const task = structuredClone(spec.tasks.find(task => task.split === (stage === 'held-out' ? 'held-out' : 'development')));
      spec.tasks.push(task);
      if (stage === 'held-out') spec.heldOutPlan.taskCount++;
    }
    const duplicate = stage === 'directional-pilot' ? spec.tasks[1] : spec.tasks.at(-1);
    duplicate[field] = field === 'seed' ? 999 : field === 'requestHash' ? hash('9') : 'different-model';
    const result = evaluateEfficiencyRuns(spec, runs(spec));
    assert.equal(result.measurementComplete, false);
    assert.ok(result.failures.some(failure => failure.includes('repository/task identity must be unique')));
  }
});

test('synthetic authorized parent/child telemetry flows through the adapter into all-arm evaluation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'efficiency-adapter-'));
  try {
    const parent = path.join(root, 'parent.jsonl'); const child = path.join(root, 'child.jsonl');
    const message = id => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 50, output_tokens: 20 } } });
    await writeFile(parent, message('parent-message')); await writeFile(child, message('child-message'));
    const sample = await recordFromTranscript(root, parent, 'parent', { childAccounting: 'complete', transcriptRoot: root, childTranscripts: [{ sessionId: 'child', parentSessionId: 'parent', transcriptPath: child }] });
    assert.equal(sample.scope.status, 'complete');
    assert.equal(sample.accounting.totalTokens, 400);
    const spec = specification(); const records = runs(spec);
    for (const run of records) run.attempts[0].usage = usageFromTelemetry(sample);
    const result = evaluateEfficiencyRuns(spec, records);
    assert.equal(result.measurementComplete, true);
    assert.equal(result.arms.baseline.tokens.total, 400);
    assert.equal(result.arms.current.tokens.perAcceptedTask, 400);
    const parentOnly = await recordFromTranscript(root, parent, 'parent-only');
    records[0].attempts[0].usage = usageFromTelemetry(parentOnly);
    assert.equal(evaluateEfficiencyRuns(spec, records).measurementComplete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI parse errors retain the nonqualifying descriptive report envelope and fail exit status', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'efficiency-cli-'));
  try {
    const specPath = path.join(root, 'malformed.json'); await writeFile(specPath, '{');
    let failure;
    try { execFileSync(process.execPath, ['scripts/evaluate-efficiency-runs.mjs', '--spec', specPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { failure = error; }
    assert.equal(failure.status, 1);
    const result = JSON.parse(failure.stdout);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.measurementComplete, false);
    assert.equal(result.releaseQualification, false);
    assert.equal(result.improvementClaim, false);
    assert.ok(result.arms.baseline);
  } finally { await rm(root, { recursive: true, force: true }); }
});
