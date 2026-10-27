import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ARMS = ['baseline', 'current', 'simplified'];
const CATEGORIES = ['uncachedInput', 'cacheWrite', 'cacheRead', 'output'];
const IDENTITY = ['taskId', 'repository', 'sourceRevision', 'model', 'modelVersion', 'requestHash', 'seed'];
const ERRORS = ['regressions', 'requiredChangesMissed', 'unnecessaryChanges', 'clarificationErrors', 'relevantContextMissed'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonnegative = value => Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const tokenSum = values => { const sum = values.reduce((total, value) => total + value, 0); return count(sum) ? sum : null; };
const canonicalValue = value => Array.isArray(value) ? value.map(canonicalValue) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])])) : value;
const canonical = value => JSON.stringify(canonicalValue(value));
const same = (left, right) => canonical(left) === canonical(right);
const pairKey = (task, repetition) => canonical([...IDENTITY.map(field => task[field]), repetition]);
const timestamp = value => text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const emptyMetric = () => ({ availability: 'unavailable', value: null });

/** The SHA-256 of canonical JSON binds records to the entire frozen specification. */
export function efficiencySpecHash(spec) {
  return createHash('sha256').update(canonical(spec)).digest('hex');
}

/** Bridge only complete, explicitly scoped telemetry; never upgrade parent-only data. */
export function usageFromTelemetry(sample) {
  const complete = sample?.accounting?.complete === true && sample?.scope?.status === 'complete';
  const fields = { uncachedInput: 'uncachedInputTokens', cacheWrite: 'cacheWriteTokens', cacheRead: 'cacheReadTokens', output: 'outputTokens' };
  const categories = Object.fromEntries(CATEGORIES.map(category => {
    const value = sample?.accounting?.[fields[category]];
    const availability = sample?.accounting?.availability?.[category];
    const available = complete && count(value) && (availability === 'reported' || (availability === 'not-applicable' && value === 0));
    return [category, { availability: available ? 'available' : 'unavailable', tokens: available ? value : null }];
  }));
  const mappedComplete = complete && Object.values(categories).every(category => category.availability === 'available');
  const totalMatches = count(sample?.accounting?.totalTokens) && sample.accounting.totalTokens === tokenSum(Object.values(categories).map(category => category.tokens ?? 0));
  return { accounting: 'disjoint', scope: mappedComplete && totalMatches ? 'complete' : sample?.scope ? 'partial' : 'unknown', categories };
}

function validateSpec(spec) {
  const failures = [];
  if (!object(spec)) return ['A frozen experiment specification is required.'];
  if (spec.schemaVersion !== 1 || !text(spec.experimentId) || spec.frozen !== true || !['development', 'directional-pilot', 'held-out'].includes(spec.stage)) failures.push('Specification lacks a frozen experiment identity or supported stage.');
  if (!timestamp(spec.preregisteredAt) || !timestamp(spec.collectionStartsAt) || Date.parse(spec.preregisteredAt) >= Date.parse(spec.collectionStartsAt)) failures.push('Preregistration must precede collection.');
  if (!Array.isArray(spec.arms) || !same([...spec.arms].sort(), [...ARMS].sort()) || !object(spec.armArtifacts) || !ARMS.every(arm => hash(spec.armArtifacts[arm]))) failures.push('Specify exactly baseline, current, and simplified arms with independent artifact hashes.');
  if (!Number.isSafeInteger(spec.repetitions) || spec.repetitions < 1) failures.push('Repetitions must be a positive integer.');
  const conditions = spec.conditions;
  if (!object(conditions) || !text(conditions.host) || !text(conditions.hostVersion) || !hash(conditions.toolPolicyHash) || !count(conditions.maxTokens) || conditions.maxTokens === 0 || !nonnegative(conditions.maxDurationMs) || conditions.maxDurationMs === 0 || !nonnegative(conditions.temperature) || conditions.temperature > 2) failures.push('Fixed host, tooling, budget, and sampling conditions are required.');
  const taskKeys = new Set(); const taskSplits = new Map();
  if (!Array.isArray(spec.tasks) || !spec.tasks.length) failures.push('Frozen development and held-out task identities are required.');
  else for (const task of spec.tasks) {
    if (!object(task) || !IDENTITY.filter(field => !['seed', 'requestHash'].includes(field)).every(field => text(task[field])) || !hash(task.requestHash) || !Number.isSafeInteger(task.seed) || !['development', 'held-out'].includes(task.split) || !Array.isArray(task.checks) || !task.checks.length || !task.checks.every(check => object(check) && text(check.id) && text(check.command)) || new Set(task.checks.map(check => check.id)).size !== task.checks.length) {
      failures.push('Every frozen task needs a fixed identity, split, seed, and unique required checks.'); continue;
    }
    const key = pairKey(task, 0);
    if (taskKeys.has(key)) failures.push('Duplicate task identity in frozen split.');
    taskKeys.add(key);
    const splitKey = canonical([task.repository, task.taskId]);
    if (taskSplits.has(splitKey)) failures.push('A repository/task identity must be unique across the entire frozen task set, independent of seed, model, request, or split.');
    taskSplits.set(splitKey, task.split);
  }
  const heldOutTasks = Array.isArray(spec.tasks) ? spec.tasks.filter(task => task?.split === 'held-out').length : 0;
  const plan = spec.heldOutPlan;
  if (!object(plan) || !Number.isSafeInteger(plan.taskCount) || plan.taskCount < 1 || plan.taskCount !== heldOutTasks || !Number.isSafeInteger(plan.repetitions) || plan.repetitions < 1 || !hash(plan.selectionHash) || !text(plan.sizeJustification) || plan.analysisUnit !== 'task' || !(plan.blindedReestimation === null || (object(plan.blindedReestimation) && plan.blindedReestimation.method === 'blinded' && hash(plan.blindedReestimation.ruleHash) && Number.isSafeInteger(plan.blindedReestimation.maximumTasks) && plan.blindedReestimation.maximumTasks >= plan.taskCount))) failures.push('Freeze the held-out split, task count, repetitions, task-level precision/power justification, and optional blinded reestimation rule before collection.');
  if (spec.stage === 'held-out' && spec.repetitions !== plan?.repetitions) failures.push('Held-out repetitions differ from the frozen plan.');
  if (spec.stage === 'directional-pilot' && (!Array.isArray(spec.tasks) || spec.tasks.filter(task => task?.split === 'development').length !== 12 || new Set(spec.tasks.filter(task => task?.split === 'development').map(task => task.repository)).size < 2 || spec.repetitions !== 3)) failures.push('The directional pilot requires 12 development tasks across at least 2 repositories and 3 repetitions per arm.');
  if (!object(spec.decisionPolicy) || !nonnegative(spec.decisionPolicy.tokenReductionTargetPct) || spec.decisionPolicy.tokenReductionTargetPct > 100 || spec.decisionPolicy.acceptancePolicy !== 'no-decrease' || spec.decisionPolicy.purpose !== 'descriptive-only') failures.push('A frozen descriptive decision policy and token target are required.');
  return failures;
}

function readUsage(usage) {
  const categories = Object.fromEntries(CATEGORIES.map(category => {
    const entry = usage?.categories?.[category];
    return [category, entry?.availability === 'available' && count(entry.tokens) ? entry.tokens : null];
  }));
  const valid = object(usage) && usage.accounting === 'disjoint' && ['complete', 'partial', 'unknown'].includes(usage.scope) && object(usage.categories) && Object.keys(usage).every(key => ['accounting', 'scope', 'categories'].includes(key)) && Object.keys(usage.categories).length === CATEGORIES.length && CATEGORIES.every(category => {
    const entry = usage.categories[category];
    return object(entry) && Object.keys(entry).every(key => ['availability', 'tokens'].includes(key)) && ((entry.availability === 'available' && count(entry.tokens)) || (entry.availability === 'unavailable' && entry.tokens === null));
  });
  return { valid, complete: valid && usage.scope === 'complete' && Object.values(categories).every(value => value !== null), categories };
}

function readMetric(metric) {
  if (metric?.availability === 'available' && nonnegative(metric.value)) return metric;
  return emptyMetric();
}

function validateRun(run, spec, expected, seen, usageIds) {
  const failures = [];
  if (!object(run)) return ['Run must be an object.'];
  const task = expected.get(pairKey(run, run.repetition));
  if (!task || !ARMS.includes(run.arm)) return ['Run does not match a frozen task, seed, repetition, and arm.'];
  const key = `${pairKey(run, run.repetition)}:${run.arm}`;
  if (seen.has(key)) failures.push('Duplicate run identity.');
  seen.add(key);
  if (run.schemaVersion !== 1 || run.evidence !== 'measured' || run.experimentId !== spec.experimentId || run.specHash !== efficiencySpecHash(spec) || run.stage !== spec.stage || run.artifactHash !== spec.armArtifacts[run.arm] || !same(run.conditions, spec.conditions)) failures.push('Run evidence, specification, arm artifact, or fixed conditions differ from preregistration.');
  if (!timestamp(run.startedAt) || !timestamp(run.completedAt) || Date.parse(run.startedAt) < Date.parse(spec.collectionStartsAt) || Date.parse(run.completedAt) < Date.parse(run.startedAt)) failures.push('Run timestamps precede collection or are invalid.');
  const checksValid = Array.isArray(run.checks) && run.checks.length === task.checks.length && new Set(run.checks.map(check => check?.id)).size === task.checks.length && task.checks.every(required => run.checks.some(check => object(check) && check.id === required.id && check.command === required.command && Number.isInteger(check.exitCode) && typeof check.timedOut === 'boolean' && hash(check.evidenceHash)));
  if (!checksValid) failures.push('Run lacks the measured required check results and evidence hashes.');
  const outcomeValid = object(run.outcome) && typeof run.outcome.accepted === 'boolean' && ERRORS.every(field => count(run.outcome[field])) && hash(run.outcome.evidenceHash);
  if (!outcomeValid) failures.push('Run lacks measured acceptance and error outcomes.');
  else if (checksValid && run.outcome.accepted !== (run.checks.every(check => check.exitCode === 0 && !check.timedOut) && ERRORS.every(field => run.outcome[field] === 0))) failures.push('Acceptance contradicts measured checks or error outcomes.');
  if (run.attemptsAccountingComplete !== true || !Array.isArray(run.attempts) || !run.attempts.length || !run.attempts.every((item, index) => object(item) && (index === 0 ? item.kind === 'initial' : ['retry', 'repair'].includes(item.kind)) && ['succeeded', 'failed', 'cancelled'].includes(item.status))) failures.push('Complete ordered attempt accounting must start with one initial attempt, followed by retries and repairs.');
  if (!object(run.maintenance) || run.maintenance.accountingComplete !== true || !hash(run.maintenance.evidenceHash) || !Array.isArray(run.maintenance.items)) failures.push('Maintenance needs an explicit complete ledger, including measured absence.');
  const items = [...(Array.isArray(run.attempts) ? run.attempts : []), ...(Array.isArray(run.maintenance?.items) ? run.maintenance.items : [])];
  for (const item of items) {
    if (!object(item) || !text(item.id) || !readUsage(item.usage).valid) { failures.push('Usage items require unique identities and explicit disjoint category availability.'); continue; }
    const id = `${run.arm}:${item.id}`;
    if (usageIds.has(id)) failures.push('An attempt or maintenance usage identity was charged more than once.');
    usageIds.add(id);
  }
  return failures;
}

function summarize(records, expectedCount, structuralComplete) {
  const items = records.flatMap(run => [...run.attempts, ...run.maintenance.items]);
  const categories = Object.fromEntries(CATEGORIES.map(category => [category, {
    observedTokens: tokenSum(items.map(item => readUsage(item.usage).categories[category] ?? 0)),
    availableItems: items.filter(item => readUsage(item.usage).categories[category] !== null).length,
    expectedItems: items.length,
  }]));
  const observedTotal = Object.values(categories).every(category => category.observedTokens !== null) ? tokenSum(Object.values(categories).map(category => category.observedTokens)) : null;
  const complete = structuralComplete && records.length === expectedCount && items.every(item => readUsage(item.usage).complete) && observedTotal !== null;
  const total = complete ? observedTotal : null;
  const accepted = records.filter(run => run.outcome.accepted).length;
  const currencies = new Set(items.map(item => item.cost?.currency));
  const costComplete = structuralComplete && items.every(item => readMetric(item.cost).availability === 'available' && text(item.cost.currency)) && currencies.size === 1;
  const cost = costComplete ? items.reduce((sum, item) => sum + item.cost.value, 0) : null;
  const latencyComplete = structuralComplete && records.every(run => readMetric(run.latencyMs).availability === 'available');
  const latency = latencyComplete ? records.reduce((sum, run) => sum + run.latencyMs.value, 0) : null;
  return {
    tasksAttempted: records.length, tasksAccepted: accepted, attempts: records.reduce((sum, run) => sum + run.attempts.length, 0), maintenanceItems: records.reduce((sum, run) => sum + run.maintenance.items.length, 0),
    accuracy: { acceptanceRatePct: records.length ? 100 * accepted / records.length : null, errors: Object.fromEntries(ERRORS.map(field => [field, records.reduce((sum, run) => sum + run.outcome[field], 0)])) },
    tokens: { complete, categories, total, perAcceptedTask: complete && accepted ? total / accepted : null },
    cost: { available: costComplete, currency: costComplete ? [...currencies][0] : null, total: cost, perAcceptedTask: costComplete && accepted ? cost / accepted : null },
    latencyMs: { available: latencyComplete, total: latency, meanPerTaskRun: latencyComplete && records.length ? latency / records.length : null },
  };
}

/** Descriptive measurement only; no stage of this evaluator qualifies a release. */
export function evaluateEfficiencyRuns(spec, records = []) {
  const failures = validateSpec(spec);
  const expected = new Map();
  if (!failures.length) for (const task of spec.tasks.filter(task => task.split === (spec.stage === 'held-out' ? 'held-out' : 'development'))) {
    for (let repetition = 1; repetition <= spec.repetitions; repetition++) expected.set(pairKey(task, repetition), task);
  }
  if (!expected.size && !failures.length) failures.push('No frozen tasks for this stage.');
  const seen = new Set(); const usageIds = new Set(); const valid = [];
  if (!Array.isArray(records)) failures.push('Measured run records must be an array.');
  else if (!failures.length) for (const [index, run] of records.entries()) {
    const errors = validateRun(run, spec, expected, seen, usageIds);
    if (errors.length) failures.push(...errors.map(error => `Run ${index}: ${error}`));
    else valid.push(run);
  }
  const pairedTaskRuns = [...expected.keys()].filter(key => ARMS.every(arm => valid.some(run => `${pairKey(run, run.repetition)}:${run.arm}` === `${key}:${arm}`))).length;
  if (pairedTaskRuns !== expected.size || !expected.size) failures.push('Missing complete baseline/current/simplified matched task runs.');
  const structuralComplete = !failures.length;
  const arms = Object.fromEntries(ARMS.map(arm => [arm, summarize(valid.filter(run => run.arm === arm), expected.size, structuralComplete)]));
  const measurementComplete = structuralComplete && ARMS.every(arm => arms[arm].tokens.complete);
  if (structuralComplete && !measurementComplete) failures.push('Token usage is unavailable, scope is incomplete, or aggregate tokens overflow safe integers; no complete token comparison is possible.');
  const reduction = (baseline, candidate) => baseline !== null && baseline > 0 && candidate !== null ? 100 * (baseline - candidate) / baseline : null;
  const comparisons = ARMS.slice(1).map(arm => ({
    baseline: 'baseline', arm,
    tokenReductionPct: measurementComplete ? reduction(arms.baseline.tokens.perAcceptedTask, arms[arm].tokens.perAcceptedTask) : null,
    costReductionPct: structuralComplete && arms.baseline.cost.currency === arms[arm].cost.currency ? reduction(arms.baseline.cost.perAcceptedTask, arms[arm].cost.perAcceptedTask) : null,
    acceptanceRateDeltaPct: structuralComplete ? arms[arm].accuracy.acceptanceRatePct - arms.baseline.accuracy.acceptanceRatePct : null,
  }));
  return {
    schemaVersion: 1, status: measurementComplete ? 'complete' : 'incomplete', stage: spec?.stage ?? null,
    measurementComplete, releaseQualification: false, improvementClaim: false,
    expectedTaskRunsPerArm: expected.size, pairedTaskRuns, arms, comparisons, failures,
    warnings: [
      'Descriptive records are not independently authenticated by this evaluator; provenance requires review.',
      'Repetitions are clustered within tasks, not independent tasks; no statistical efficacy inference is performed.',
      ...(ARMS.some(arm => !arms[arm].tasksAccepted) ? ['Zero accepted task runs leaves tokens/cost per accepted task undefined.'] : []),
    ],
  };
}

export async function main(args = process.argv.slice(2)) {
  const argument = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  try {
    const specPath = argument('--spec'); const resultsPath = argument('--results');
    const spec = specPath ? JSON.parse(await readFile(specPath, 'utf8')) : null;
    const records = resultsPath ? JSON.parse(await readFile(resultsPath, 'utf8')) : [];
    const result = evaluateEfficiencyRuns(spec, records);
    console.log(JSON.stringify(result, null, 2));
    if (!result.measurementComplete) process.exitCode = 1;
    return result;
  } catch (error) {
    const result = { ...evaluateEfficiencyRuns(null), failures: [error.message] };
    console.log(JSON.stringify(result, null, 2)); process.exitCode = 1; return result;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
