import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { captureBaseline, checkBaseline } from '../scripts/capture-efficiency-baseline.mjs';

const exec = promisify(execFile);
const tool = path.resolve('scripts/capture-efficiency-baseline.mjs');
const git = (root, ...args) => exec('git', ['-C', root, ...args], { encoding: 'utf8' });

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'gw-efficiency-baseline-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await git(root, 'init', '--quiet');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'user.name', 'Disposable fixture');
  await git(root, 'config', 'core.filemode', 'true');
  await writeFile(path.join(root, 'src/staged.txt'), 'HEAD\n');
  await writeFile(path.join(root, 'src/deleted.txt'), 'delete me\n');
  await writeFile(path.join(root, 'src/binary.bin'), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(root, '.env.production'), 'SYNTHETIC_PRIVATE_HEAD=never-archive\n');
  await writeFile(path.join(root, '.gitignore'), 'dist/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'synthetic HEAD');
  await writeFile(path.join(root, 'src/staged.txt'), 'INDEX\n');
  await git(root, 'add', 'src/staged.txt');
  await writeFile(path.join(root, 'src/staged.txt'), 'WORKTREE\n');
  await git(root, 'rm', '--quiet', 'src/deleted.txt');
  await writeFile(path.join(root, 'src/binary.bin'), Buffer.from([0, 1, 9, 255, 0]));
  await writeFile(path.join(root, 'src/new.txt'), 'untracked current bytes\n');
  await writeFile(path.join(root, '.env.production'), 'SYNTHETIC_PRIVATE_WORKTREE=never-archive\n');
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist/generated.js'), 'excluded generated\n');
  await mkdir(path.join(root, '.graphward/knowledge-base'), { recursive: true });
  await writeFile(path.join(root, '.graphward/knowledge-base/note.md'), 'canonical artifact\n');
  return { base, root, output: path.join(base, 'archive') };
}

test('capture preserves staged, unstaged, binary, added/deleted and canonical artifact state without changing Git', async t => {
  const f = await fixture(t);
  const status = (await git(f.root, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).stdout;
  const result = await captureBaseline({ ...f, artifactPaths: ['.graphward/knowledge-base/note.md'] });
  const manifest = JSON.parse(await readFile(path.join(f.output, 'manifest.json'), 'utf8'));
  assert.equal((await git(f.root, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).stdout, status);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(manifest.git.statusBase64, Buffer.from(status).toString('base64'));
  assert.equal(manifest.git.dirty, true);
  assert.ok(manifest.files.find(entry => entry.path === 'src/deleted.txt' && entry.exists === false));
  assert.ok(manifest.files.find(entry => entry.path === 'src/new.txt' && entry.exists));
  assert.deepEqual(manifest.dirtyArtifactPaths, ['.graphward/knowledge-base/note.md']);
  assert.ok(manifest.files.find(entry => entry.path === '.graphward/knowledge-base/note.md' && entry.kind === 'artifact'));
  assert.ok(!manifest.files.some(entry => entry.path.startsWith('dist/') || entry.path === '.env.production'));
  assert.ok(manifest.exclusions.find(entry => entry.path === '.env.production'));
  for (const name of ['manifest.json', 'staged.patch', 'unstaged.patch']) {
    assert.ok(!(await readFile(path.join(f.output, name), 'utf8')).includes('SYNTHETIC_PRIVATE_'));
  }
  const check = await checkBaseline({ root: f.root, baseline: f.output, expectedDigest: result.digest });
  assert.equal(check.integrity, true);
  assert.equal(check.anchored, true);
  assert.equal(check.unchanged, true);

  // Prove the patches reproduce distinct index/worktree state from the known HEAD.
  const restored = path.join(f.base, 'restored');
  await exec('git', ['clone', '--quiet', '--no-hardlinks', f.root, restored]);
  await git(restored, 'apply', '--index', path.join(f.output, 'staged.patch'));
  await git(restored, 'apply', path.join(f.output, 'unstaged.patch'));
  for (const entry of manifest.files.filter(entry => entry.exists)) {
    await mkdir(path.dirname(path.join(restored, entry.path)), { recursive: true });
    await copyFile(path.join(f.output, entry.backup), path.join(restored, entry.path));
    await chmod(path.join(restored, entry.path), entry.mode);
    assert.deepEqual(await readFile(path.join(restored, entry.path)), await readFile(path.join(f.root, entry.path)));
  }
  assert.equal((await git(restored, 'show', ':src/staged.txt')).stdout, 'INDEX\n');
  assert.equal(await readFile(path.join(restored, 'src/staged.txt'), 'utf8'), 'WORKTREE\n');
  assert.match(await readFile(path.join(f.output, 'unstaged.patch'), 'utf8'), /GIT binary patch/);
  await assert.rejects(readFile(path.join(restored, 'src/deleted.txt')), { code: 'ENOENT' });
});

test('full check reports intentional source differences while selected-path check preserves original dirty bytes', async t => {
  const f = await fixture(t);
  const { digest } = await captureBaseline(f);
  await writeFile(path.join(f.root, 'src/later.txt'), 'intentional implementation addition\n');
  await writeFile(path.join(f.root, '.graphward/knowledge-base/note.md'), 'refreshed generated artifact\n');
  const preserved = await checkBaseline({ root: f.root, baseline: f.output, expectedDigest: digest, paths: ['src/staged.txt', 'src/binary.bin', 'src/deleted.txt'] });
  assert.equal(preserved.preserved, true);
  assert.equal(preserved.statusMatches, false);
  assert.equal(preserved.unchanged, undefined);
  const full = await checkBaseline({ root: f.root, baseline: f.output, expectedDigest: digest });
  assert.equal(full.unchanged, false);
  assert.deepEqual(full.differences, [{ path: 'src/later.txt', reason: 'added' }]);
  await writeFile(path.join(f.root, 'src/staged.txt'), 'changed original dirty bytes\n');
  await unlink(path.join(f.root, 'src/new.txt'));
  const changed = await checkBaseline({ root: f.root, baseline: f.output });
  assert.equal(changed.anchored, false);
  assert.ok(changed.differences.some(entry => entry.path === 'src/staged.txt' && entry.reason === 'content'));
  assert.ok(changed.differences.some(entry => entry.path === 'src/new.txt' && entry.reason === 'deleted'));
  await assert.rejects(checkBaseline({ root: f.root, baseline: f.output, paths: ['unknown.txt'] }), /not captured/);
});

test('checks detect mode-only changes independently of source content', async t => {
  const f = await fixture(t);
  await captureBaseline(f);
  await chmod(path.join(f.root, 'src/staged.txt'), 0o755);
  const check = await checkBaseline({ root: f.root, baseline: f.output, paths: ['src/staged.txt'] });
  assert.equal(check.preserved, false);
  assert.deepEqual(check.differences, [{ path: 'src/staged.txt', reason: 'mode' }]);
});

test('selected-path preservation also detects changes to the original staged state', async t => {
  const f = await fixture(t);
  await captureBaseline(f);
  await git(f.root, 'add', 'src/staged.txt');
  const check = await checkBaseline({ root: f.root, baseline: f.output, paths: ['src/staged.txt'] });
  assert.equal(check.sourceMatches, true);
  assert.equal(check.selectedIndexMatches, false);
  assert.equal(check.preserved, false);
});

test('configured roots accept normal trailing slashes and explicit claims remain separate canonical artifacts', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.graphward/claims'), { recursive: true });
  await writeFile(path.join(f.root, '.graphward/claims/index.json'), '{"synthetic":true}\n');
  await writeFile(path.join(f.root, '.graphward/gw.config.json'), JSON.stringify({ projectFiles: { roots: ['./src/'] } }));
  await captureBaseline({ ...f, artifactPaths: ['.graphward/claims/index.json'] });
  const manifest = JSON.parse(await readFile(path.join(f.output, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.filter(entry => entry.kind === 'source').every(entry => entry.path.startsWith('src/')));
  assert.ok(manifest.files.find(entry => entry.path === '.graphward/claims/index.json' && entry.kind === 'artifact'));
  assert.equal((await checkBaseline({ root: f.root, baseline: f.output })).unchanged, true);
});

test('fixed policy configuration is backed up and config-only changes invalidate full identity', async t => {
  const f = await fixture(t);
  const config = '.graphward/gw.config.json';
  const legacy = '.graphward/config.json';
  await writeFile(path.join(f.root, config), JSON.stringify({ providers: { policy: 'native' } }));
  await writeFile(path.join(f.root, legacy), JSON.stringify({ tokenBudgets: { example: 100 } }));
  const { digest } = await captureBaseline(f);
  const manifest = JSON.parse(await readFile(path.join(f.output, 'manifest.json'), 'utf8'));
  for (const file of [config, legacy]) {
    const entry = manifest.files.find(item => item.path === file);
    assert.equal(entry.kind, 'configuration');
    assert.deepEqual(await readFile(path.join(f.output, entry.backup)), await readFile(path.join(f.root, file)));
  }
  assert.equal(manifest.files.filter(entry => entry.path === '.gitignore').length, 1);
  await writeFile(path.join(f.root, config), JSON.stringify({ providers: { policy: 'auto' } }));
  const changed = await checkBaseline({ root: f.root, baseline: f.output, expectedDigest: digest });
  assert.equal(changed.unchanged, false);
  assert.ok(changed.differences.some(entry => entry.path === config && entry.reason === 'content'));
  const preserved = await checkBaseline({ root: f.root, baseline: f.output, paths: ['src/staged.txt'] });
  assert.equal(preserved.preserved, true);
});

test('manifest, backup and patch tampering fail integrity checks and pinned digest rejects rewritten receipt', async t => {
  const f = await fixture(t);
  const { digest } = await captureBaseline(f);
  const manifestFile = path.join(f.output, 'manifest.json');
  const originalManifest = await readFile(manifestFile);
  const manifest = JSON.parse(originalManifest);
  const backup = path.join(f.output, manifest.files.find(entry => entry.path === 'src/new.txt').backup);
  const originalBackup = await readFile(backup);
  await writeFile(backup, 'tampered backup');
  await assert.rejects(checkBaseline({ root: f.root, baseline: f.output, expectedDigest: digest }), /Content backup integrity/);
  await writeFile(backup, originalBackup);
  const patch = path.join(f.output, 'staged.patch');
  const originalPatch = await readFile(patch);
  await writeFile(patch, 'tampered patch');
  await assert.rejects(checkBaseline({ root: f.root, baseline: f.output }), /Patch integrity/);
  await writeFile(patch, originalPatch);
  await writeFile(manifestFile, `${originalManifest} `);
  await assert.rejects(checkBaseline({ root: f.root, baseline: f.output }), /manifest digest/);
  // A separately recorded digest remains the trust anchor if both local files change.
  const { createHash } = await import('node:crypto');
  await writeFile(path.join(f.output, 'manifest.sha256'), createHash('sha256').update(await readFile(manifestFile)).digest('hex'));
  await assert.rejects(checkBaseline({ root: f.root, baseline: f.output, expectedDigest: digest }), /manifest digest/);
});

test('capture refuses overwrite, recursion, symlinked policy/backup paths, private artifacts and escape paths', async t => {
  const f = await fixture(t);
  await captureBaseline(f);
  await assert.rejects(captureBaseline(f), /overwrite/);
  await assert.rejects(captureBaseline({ ...f, output: path.join(f.root, 'archive') }), /outside/);
  await assert.rejects(captureBaseline({ ...f, output: path.join(f.base, 'bad'), artifactPaths: ['.graphward/reports/../../.env'] }), /Unsafe relative/);
  await assert.rejects(captureBaseline({ ...f, output: path.join(f.base, 'bad'), artifactPaths: ['.graphward/reports/.env'] }), /nonsecret/);
  await assert.rejects(captureBaseline({ ...f, output: path.join(f.base, 'bad'), artifactPaths: ['.graphward/gw.config.json'] }), /canonical/);
  await assert.rejects(checkBaseline({ root: f.root, baseline: f.output, paths: ['../outside'] }), /Unsafe relative/);
  const outside = path.join(f.base, 'outside-secret.txt');
  await writeFile(outside, 'synthetic outside bytes');
  await symlink(outside, path.join(f.root, 'src/escape.txt'));
  const safeOutput = path.join(f.base, 'safe');
  await captureBaseline({ ...f, output: safeOutput });
  const safeManifest = JSON.parse(await readFile(path.join(safeOutput, 'manifest.json'), 'utf8'));
  assert.ok(!safeManifest.files.some(entry => entry.path === 'src/escape.txt'));
  assert.ok(safeManifest.exclusions.some(entry => entry.path === 'src/escape.txt' && /symlink/.test(entry.reason)));
  await unlink(path.join(f.root, '.gitignore'));
  await symlink(outside, path.join(f.root, '.gitignore'));
  await assert.rejects(captureBaseline({ ...f, output: path.join(f.base, 'unsafe') }), /Symlink/);
  const manifest = JSON.parse(await readFile(path.join(f.output, 'manifest.json'), 'utf8'));
  const backup = path.join(f.output, manifest.files.find(entry => entry.path === 'src/new.txt').backup);
  await unlink(backup);
  await symlink(outside, backup);
  await assert.rejects(checkBaseline({ root: f.root, baseline: f.output }), /Symlink/);
});

test('capture enforces byte and file count limits without publishing a misleading archive', async t => {
  const f = await fixture(t);
  await assert.rejects(captureBaseline({ ...f, maxFileBytes: 2 }), /File byte limit/);
  await assert.rejects(captureBaseline({ ...f, maxTotalBytes: 3 }), /Total byte limit/);
  await assert.rejects(captureBaseline({ ...f, maxFiles: 1 }), /File count limit/);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('a one-source-file budget roundtrips with fixed missing policy inputs', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'single.txt'), 'single source\n');
  await mkdir(path.join(f.root, '.graphward'), { recursive: true });
  await writeFile(path.join(f.root, '.graphward/gw.config.json'), JSON.stringify({ projectFiles: { roots: ['single.txt'] } }));
  const captured = await captureBaseline({ ...f, maxFiles: 1 });
  assert.equal(captured.sourceFiles, 1);
  const checked = await checkBaseline({ root: f.root, baseline: f.output, expectedDigest: captured.digest });
  assert.equal(checked.unchanged, true);
  await assert.rejects(captureBaseline({ ...f, output: path.join(f.base, 'too-many-artifacts'), maxFiles: 1,
    artifactPaths: ['.graphward/reports/one.md', '.graphward/reports/two.md'] }), /File count limit/);
});

test('capture detects concurrent source writers rather than certifying mixed bytes', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'src/racing.bin'), Buffer.alloc(1024 * 1024, 1));
  const writer = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const target = process.argv[1];
    const bytes = Buffer.alloc(1024 * 1024);
    process.stdout.write('ready\\n');
    for (let i = 0; i < 10000; i++) { bytes.fill(i % 251); fs.writeFileSync(target, bytes); }
  `, path.join(f.root, 'src/racing.bin')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => writer.kill());
  await once(writer.stdout, 'data');
  await assert.rejects(captureBaseline(f), /changed during capture|state changed during capture/);
  writer.kill();
});

test('CLI emits a reusable digest and exits nonzero when a later comparison differs', async t => {
  const f = await fixture(t);
  const captured = JSON.parse((await exec(process.execPath, [tool, 'capture', '--root', f.root, '--output', f.output])).stdout);
  const args = [tool, 'check', '--root', f.root, '--baseline', f.output, '--expected-digest', captured.digest];
  assert.equal(JSON.parse((await exec(process.execPath, args)).stdout).unchanged, true);
  await writeFile(path.join(f.root, 'src/new.txt'), 'changed\n');
  await assert.rejects(exec(process.execPath, args), error => error.code === 1 && JSON.parse(error.stdout).unchanged === false);
});
