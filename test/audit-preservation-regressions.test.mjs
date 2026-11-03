import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { install, uninstall } from '../dist/installer/index.js';
import { migrateGwConfig } from '../dist/config/index.js';
import { runSetup } from '../dist/orchestrators/setup.js';
import { hashContent } from '../dist/manifest/index.js';
import { runProcess } from '../dist/process/index.js';
import { ResourceGovernor } from '../dist/governor/resource-governor.js';
import { installProvider, managedProviderPaths } from '../dist/providers/manager.js';
import { evaluateExperimentStep, startExperiment } from '../dist/experiment/runner.js';
import { generateDashboardHTML } from '../dist/visualizer/index.js';
import { SqlitePartitionedStore } from '../dist/storage/sqlite-store.js';
import { ExecutionFlowTracker } from '../dist/runtime/execution-flow.js';
import { createSymbolId } from '../dist/graph/symbol-identity.js';
import { resolveIdentity, seedFromGitHistory } from '../dist/user-profile/index.js';

const options = { packageVersion: '1.3.3' };
async function fixture(t) { const root = await mkdtemp(path.join(tmpdir(), 'gw-repair-preserve-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function write(root, file, value) { const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value)); }
const git = (root, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function repo(t) { const root = await fixture(t); git(root, 'init', '-q'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture'); await write(root, '.gitignore', '.graphward/\n'); await write(root, 'target.cjs', 'module.exports=100;\n'); await write(root, 'metric.cjs', "console.log(require('./target.cjs'));\n"); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture'); return root; }
const evaluate = (root, extra = {}) => evaluateExperimentStep(root, { goal: 'fixture', hypothesis: 'smaller', targetFile: 'target.cjs', baselineValue: 100, metricConfig: { name: 'fixture', command: 'node metric.cjs', goal: 'minimize' }, skipGates: true, autoRollback: false, ...extra });

test('F08 custom ignore survives installation and every managed ignore write is inventoried', async t => {
  const root = await fixture(t); await write(root, '.graphward/.gitignore', '# user rule\nprivate-client-notes/\n');
  const result = await install(root, ['generic'], options);
  assert.match(await readFile(path.join(root, '.graphward/.gitignore'), 'utf8'), /private-client-notes\//);
  assert.ok(result.actions.some(item => item.path === '.graphward/.gitignore' && item.status === 'updated'));
});
test('F09 malformed configuration is diagnosed without changing its bytes', async t => {
  const root = await fixture(t); const bytes = '{"providers":{"policy":"native","offline":true}'; await write(root, '.graphward/gw.config.json', bytes);
  await assert.rejects(migrateGwConfig(root), /invalid|malformed|parse/i);
  assert.equal(await readFile(path.join(root, '.graphward/gw.config.json'), 'utf8'), bytes);
});
test('F10 uninstall retains malformed shared hook settings and reports conflict', async t => {
  const root = await fixture(t); await install(root, ['codex'], options); const bytes = '{"hooks": broken'; await write(root, '.codex/hooks.json', bytes);
  const result = await uninstall(root, options);
  assert.equal(await readFile(path.join(root, '.codex/hooks.json'), 'utf8'), bytes);
  assert.ok(result.actions.some(item => item.path === '.codex/hooks.json' && item.status === 'conflict'));
});
test('F11 manifest traversal and symlink targets preserve outside bytes', async t => {
  const parent = await fixture(t); const root = path.join(parent, 'repo'); await mkdir(root); await write(parent, 'outside.txt', 'SENTINEL'); await symlink(path.join(parent, 'outside.txt'), path.join(root, 'link.txt'));
  for (const target of ['../outside.txt', 'link.txt']) {
    await write(root, '.graphward/install-manifest.json', { schemaVersion: 1, adapters: ['generic'], files: [{ path: target, kind: 'file', hash: hashContent('SENTINEL'), owners: ['generic'] }] });
    const result = await uninstall(root, options); assert.ok(result.conflicts > 0); assert.equal(await readFile(path.join(parent, 'outside.txt'), 'utf8'), 'SENTINEL');
  }
});
test('F12 timeout and cancellation own finite descendants and have bounded stream teardown', async t => {
  const root = await fixture(t); await write(root, 'parent.mjs', "import{spawn}from'node:child_process';spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:['ignore','inherit','inherit']});setTimeout(()=>{},7000);\n");
  const before = Date.now(); const result = await runProcess({ command: process.execPath, args: [path.join(root, 'parent.mjs')], timeoutMs: 100 });
  assert.equal(result.timedOut, true); assert.ok(Date.now() - before < 3900);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 100); const cancel = Date.now(); const cancelled = await runProcess({ command: process.execPath, args: [path.join(root, 'parent.mjs')], signal: controller.signal });
  assert.equal(cancelled.exitCode, 130); assert.ok(Date.now() - cancel < 3900);
});
test('F15 missing rollback baseline never overwrites pre-existing staged or working edits', async t => {
  const root = await repo(t); await write(root, 'target.cjs', 'module.exports=110;//USER\n'); git(root, 'add', 'target.cjs'); await write(root, 'target.cjs', 'module.exports=200;//USER\n');
  const index = git(root, 'show', ':target.cjs'); const before = await readFile(path.join(root, 'target.cjs'), 'utf8');
  await assert.rejects(evaluate(root, { autoRollback: true }), /baseline|snapshot/i);
  assert.equal(await readFile(path.join(root, 'target.cjs'), 'utf8'), before); assert.equal(git(root, 'show', ':target.cjs'), index);
});
test('F15 captured experiment baseline restores dirty bytes and staged index exactly', async t => {
  const root = await repo(t); await write(root, 'target.cjs', 'module.exports=110;//STAGED\n'); git(root, 'add', 'target.cjs'); await write(root, 'target.cjs', 'module.exports=120;//WORKING\n');
  const index = git(root, 'show', ':target.cjs'); const before = await readFile(path.join(root, 'target.cjs'), 'utf8'); const flight = await startExperiment(root, { goal: 'fixture', hypothesis: 'smaller', targetFile: 'target.cjs' });
  await write(root, 'target.cjs', 'module.exports=200;\n'); await evaluate(root, { flightId: flight.id, autoRollback: true });
  assert.equal(await readFile(path.join(root, 'target.cjs'), 'utf8'), before); assert.equal(git(root, 'show', ':target.cjs'), index);
});
test('F15 out-of-scope edits are preserved while the owned experiment target reverts', async t => {
  const root = await repo(t); const flight = await startExperiment(root, { goal: 'fixture', hypothesis: 'smaller', targetFile: 'target.cjs' }); await write(root, 'other.js', 'export const userWork=true;\n'); await write(root, 'target.cjs', 'module.exports=200;\n');
  const result = await evaluate(root, { flightId: flight.id, autoRollback: true }); assert.equal(result.revertReason, 'out_of_bounds'); assert.equal(await readFile(path.join(root, 'other.js'), 'utf8'), 'export const userWork=true;\n'); assert.match(result.tierResults.gates.summary, /Out-of-scope edits were preserved/);
});
test('F15 private baseline snapshots are ignored while custom ignore rules survive', async t => {
  const root = await repo(t); await write(root, '.gitignore', ''); await write(root, '.graphward/.gitignore', 'user-private/\n'); const flight = await startExperiment(root, { goal: 'fixture', hypothesis: 'smaller', targetFile: 'target.cjs' });
  assert.match(await readFile(path.join(root, '.graphward/.gitignore'), 'utf8'), /^user-private\/\nexperiment-baselines\/\n$/);
  assert.match(git(root, 'check-ignore', `.graphward/experiment-baselines/${flight.id}.json`), /experiment-baselines/);
});
test('F16 isolated experiment measures exact dirty candidate including untracked input', async t => {
  const root = await repo(t); await write(root, 'target.cjs', "module.exports=require('./new-input.cjs');\n"); await write(root, 'new-input.cjs', 'module.exports=50;\n');
  const before = git(root, 'status', '--porcelain'); const result = await evaluate(root, { useWorktree: true });
  assert.equal(result.measuredValue, 50); assert.equal(git(root, 'status', '--porcelain'), before);
});
test('F15 metrics or checks changing the frozen candidate preserve later bytes and index', async t => {
  for (const stage of ['metric', 'check']) {
    const root = await repo(t);
    await write(root, 'mutate.cjs', "require('node:fs').writeFileSync('target.cjs','module.exports=77;//LATER\\n');require('node:child_process').execFileSync('git',['add','target.cjs']);console.log(200);" + (stage === 'check' ? 'process.exitCode=1;' : ''));
    const flight = await startExperiment(root, { goal: 'fixture', hypothesis: 'smaller', targetFile: 'target.cjs' }); await write(root, 'target.cjs', 'module.exports=50;\n');
    const result = await evaluate(root, { flightId: flight.id, autoRollback: true, ...(stage === 'metric' ? { metricConfig: { name: 'fixture', command: 'node mutate.cjs', goal: 'minimize' } } : { testCommand: 'node mutate.cjs' }) });
    assert.equal(result.verdict, 'ERROR'); assert.equal(result.qualified, false); assert.match(await readFile(path.join(root, 'target.cjs'), 'utf8'), /LATER/); assert.match(git(root, 'show', ':target.cjs'), /LATER/);
  }
});
test('F16 worktree KEEP refuses promotion if the main candidate changed during measurement', async t => {
  const root = await repo(t); await write(root, 'target.cjs', 'module.exports=50;\n'); await write(root, 'mutate-main.cjs', `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'target.cjs'))},'module.exports=88;//LATER\\n');console.log(50);`);
  const head = git(root, 'rev-parse', 'HEAD'); const result = await evaluate(root, { useWorktree: true, commitOnKeep: true, metricConfig: { name: 'fixture', command: 'node mutate-main.cjs', goal: 'minimize' } });
  assert.equal(result.verdict, 'ERROR'); assert.equal(result.qualified, false); assert.match(await readFile(path.join(root, 'target.cjs'), 'utf8'), /LATER/); assert.equal(git(root, 'rev-parse', 'HEAD'), head);
});
test('F16 untracked executable mode and binary candidate bytes survive isolated transfer', async t => {
  const root = await repo(t); await write(root, 'measure.sh', '#!/bin/sh\nprintf 50\n'); await chmod(path.join(root, 'measure.sh'), 0o755); await writeFile(path.join(root, 'data.bin'), Buffer.from([0, 255, 13, 10, 128]));
  const result = await evaluate(root, { useWorktree: true, metricConfig: { name: 'fixture', command: './measure.sh', goal: 'minimize' } }); assert.equal(result.measuredValue, 50); assert.equal(result.verdict, 'KEEP'); assert.ok(result.candidateHash);
});
test('F17 metric-only KEEP retains skipped and unavailable verification states', async t => {
  const root = await repo(t); await write(root, 'target.cjs', 'module.exports=50;\n'); const result = await evaluate(root);
  assert.equal(result.verdict, 'KEEP'); assert.equal(result.tierResults.gates.status, 'skipped'); assert.equal(result.tierResults.tests.status, 'unavailable');
  assert.equal(result.qualified, false);
});
test('F18/F19 dashboard exports scoped public artifacts and disables active workspace markup', async t => {
  const parent = await fixture(t); const root = path.join(parent, 'repo'); await mkdir(root); await write(root, '.graphward/memory/users/fixture/user-intelligence.md', 'PRIVATE_SENTINEL'); await write(parent, 'outside.json', 'OUTSIDE_SENTINEL'); await write(root, '.graphward/knowledge-base/public.md', '# Public\n<img src=x onerror=alert(1)>'); await symlink(path.join(parent, 'outside.json'), path.join(root, '.graphward/knowledge-base/escape.json'));
  const html = await generateDashboardHTML(root); const match = html.match(/const WORKSPACE_FILES = ([\s\S]*?);\nconst VAULT_NAME/); const exported = JSON.parse(match[1]);
  assert.equal(Object.values(exported).some(value => /PRIVATE_SENTINEL|OUTSIDE_SENTINEL/.test(value)), false); assert.ok(exported['.graphward/knowledge-base/public.md']);
  assert.match(html, /securityLevel: 'strict'/); assert.match(html, /renderer\.html\s*=/); assert.match(html, /Export inventory/);
  // Execute the actual browser renderer registration with inert host stubs.
  const rendererSource = html.slice(html.indexOf('function escapeHtml(s)'), html.indexOf('marked.setOptions({ renderer });') + 'marked.setOptions({ renderer });'.length);
  const marked = { Renderer: function() {}, setOptions(value) { this.renderer = value.renderer; } };
  vm.runInNewContext(rendererSource, { marked, mermaid: { initialize() {} } });
  assert.equal(marked.renderer.html({ text: '<img src=x onerror="sentinel()">' }).startsWith('&lt;img'), true);
  assert.equal(marked.renderer.link({ href: 'javascript:sentinel()', text: 'Click' }), 'Click');
  assert.equal(marked.renderer.image({ href: 'https://invalid.example/sentinel', text: 'Image' }), 'Image');
});
test('F31 setup installs explicitly requested additional adapters', async t => {
  const root = await fixture(t); await install(root, ['generic'], options); const result = await runSetup(root, { ...options, ides: ['codex'], deferIntelligenceBuild: true });
  const manifest = JSON.parse(await readFile(path.join(root, '.graphward/install-manifest.json'), 'utf8'));
  assert.ok(manifest.adapters.includes('codex')); assert.ok(manifest.adapters.includes('generic')); assert.ok(existsSync(path.join(root, '.codex/config.toml'))); assert.deepEqual(result.ides, manifest.adapters);
});
test('F32 exact post-activation failure restores previous provider instead of crediting fallback', async t => {
  const home = await fixture(t); const legacy = managedProviderPaths('graphify', home).executable; const previous = path.join(home, 'graphify/previous/bin/graphify'); for (const file of [legacy, previous]) await write(home, path.relative(home, file), 'fixture');
  const current = path.join(home, 'graphify/current.json'); const before = JSON.stringify({ version: '0.9.29', executable: previous }); await writeFile(current, before); let staged; let calls = 0;
  const runner = async request => { const result = (exitCode, stdout = '') => ({ command: request.command, args: request.args ?? [], exitCode, stdout, stderr: '', timedOut: false }); if (request.command === 'uv' && request.args?.[0] === '--version') return result(0, 'uv fixture'); if (request.command === 'uv' && request.args?.[0] === 'tool') { staged = path.join(request.env.UV_TOOL_BIN_DIR, path.basename(legacy)); await write(home, path.relative(home, staged), 'stage'); return result(0); } if (request.command === staged) return ++calls === 1 ? result(0, 'graphify 0.9.29') : result(1); if ([legacy, previous].includes(request.command)) return result(0, 'graphify 0.9.29'); return result(1); };
  const status = await installProvider('graphify', { providerHome: home, runner }); assert.notEqual(status.health, 'healthy'); assert.equal(await readFile(current, 'utf8'), before);
});
test('F36 IOPS throttle resets its exhausted window and reports local-only capability', async () => {
  const governor = new ResourceGovernor({ iopsBudgetPerSec: 1 }); assert.equal(governor.checkIopsThrottle(), false); assert.equal(governor.checkIopsThrottle(), true); await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(governor.checkIopsThrottle(), false); assert.match(governor.formatResourceReport(), /local|current process/i);
});
test('F39 runtime tracker persists one increment per observed event', async () => {
  const store = new SqlitePartitionedStore(':memory:'); await store.initialize(); try { const tracker = new ExecutionFlowTracker(store); const a = createSymbolId({ path: 'a.js', qualifiedName: 'a' }); const b = createSymbolId({ path: 'b.js', qualifiedName: 'b' }); for (let i = 0; i < 3; i++) tracker.recordInvocation(a, b); assert.equal(store.getRuntimeObservations()[0].count, 3); } finally { store.close(); }
});
test('F40 unavailable file-backed sqlite fails explicitly; accepted memory fallback rolls back', async t => {
  const root = await fixture(t); const moduleUrl = new URL('../dist/storage/sqlite-store.js', import.meta.url).href;
  const script = `import{SqlitePartitionedStore}from ${JSON.stringify(moduleUrl)};let rejected=false;try{await new SqlitePartitionedStore(${JSON.stringify(path.join(root, 'store.sqlite'))}).initialize()}catch{rejected=true}const s=new SqlitePartitionedStore(':memory:');await s.initialize();try{s.transaction(()=>{s.insertSymbol({id:'a',repository:'r',package:'p',language:'js',path:'a.js',qualifiedName:'a',declarationHash:'h'});throw Error('fixture')})}catch{}const accepted=new SqlitePartitionedStore(${JSON.stringify(path.join(root, 'optin.sqlite'))},{allowDegradedMemory:true});await accepted.initialize();let asyncCalled=false;try{s.transaction(async()=>{asyncCalled=true})}catch{}console.log(JSON.stringify({rejected,retained:!!s.getSymbol('a'),capabilities:s.getCapabilities(),accepted:accepted.getCapabilities(),asyncCalled}));`;
  const disableSqlite = process.allowedNodeEnvironmentFlags.has('--no-experimental-sqlite') ? ['--no-experimental-sqlite'] : [];
  const actual = JSON.parse(execFileSync(process.execPath, [...disableSqlite, '--input-type=module', '-e', script], { encoding: 'utf8' })); assert.equal(actual.rejected, true); assert.equal(actual.retained, false); assert.equal(actual.capabilities.durable, false); assert.equal(actual.capabilities.transactions, true); assert.equal(actual.accepted.degraded, true); assert.equal(actual.accepted.durable, false); assert.equal(actual.asyncCalled, false);
});
test('F40 synchronous transactions reject async callbacks before effects and rollback thenable results', async () => {
  const store = new SqlitePartitionedStore(':memory:'); await store.initialize(); try {
    let invoked = false; assert.throws(() => store.transaction(async () => { invoked = true; }), /synchronous|async/i); assert.equal(invoked, false);
    assert.throws(() => store.transaction(() => { store.insertSymbol({ id: 'thenable', repository: 'r', package: 'p', language: 'js', path: 'a.js', qualifiedName: 'a', declarationHash: 'h' }); return { then() {} }; }), /synchronous|thenable/i); assert.equal(store.getSymbol('thenable') == null, true); assert.equal(store.getCapabilities().transactionMode, 'synchronous');
  } finally { store.close(); }
});
test('F41 ESM IDE detection and per-commit change denominator use real inputs', async t => {
  const root = await repo(t); await mkdir(path.join(root, '.codex')); await mkdir(path.join(root, '.claude')); assert.deepEqual(resolveIdentity(root).ideInUse.sort(), ['claude-code', 'codex']);
  const signals = seedFromGitHistory(root, 'fixture@example.invalid'); assert.equal(signals.avgLinesChanged, 3);
});
