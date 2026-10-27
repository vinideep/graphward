#!/usr/bin/env node
// Local, scoped source preservation. This does not archive Git objects, secrets,
// ignored/generated files, dependencies, or the runtime environment.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ProjectFilePolicy } from '../dist/project-files/index.js';

const run = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const defaults = { maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxFiles: 20_000 };
const policyInputs = ['.gitignore', '.gwignore', '.eiignore', '.graphward/gw.config.json', '.graphward/config.json'];
const canonical = /^\.graphward\/(?:knowledge-base|aidlc|memory|context|events|graph|claims|reports|flight|changes)\//;
const sensitive = /(^|\/)(?:\.env(?:[./]|$)|\.aws(?:\/|$)|\.ssh(?:\/|$)|\.gnupg(?:\/|$)|(?:id_rsa|id_ed25519|credentials)(?:[./]|$))|\.(?:pem|key|p12|pfx)$/i;
const slash = value => value.split(path.sep).join('/');
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe relative path: ${value}`);
  return value;
}

function limitsFrom(options) {
  const result = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, options[key] ?? value]));
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
  }
  return result;
}

async function regular(root, relative, maxBytes, missing = false) {
  relativePath(relative);
  const location = path.join(root, relative);
  let info;
  try {
    let cursor = root;
    for (const component of relative.split('/')) {
      cursor = path.join(cursor, component);
      const componentInfo = await lstat(cursor);
      if (componentInfo.isSymbolicLink()) throw new Error(`Symlink is not captured: ${relative}`);
    }
    info = await lstat(location);
  } catch (error) {
    if (missing && error.code === 'ENOENT') return { path: relative, exists: false };
    throw error;
  }
  if (!info.isFile()) throw new Error(`Not a regular file: ${relative}`);
  if (info.size > maxBytes) throw new Error(`File byte limit exceeded: ${relative}`);
  if (!inside(root, await realpath(location))) throw new Error(`Path escapes root: ${relative}`);
  const handle = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const final = await lstat(location);
    const identity = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs].join(':');
    if (bytes.length > maxBytes) throw new Error(`File byte limit exceeded: ${relative}`);
    if (identity(info) !== identity(before) || identity(before) !== identity(after) || identity(after) !== identity(final)
      || final.isSymbolicLink() || !inside(root, await realpath(location))) throw new Error(`File changed during capture: ${relative}`);
    return { path: relative, exists: true, bytes: bytes.length, mode: before.mode & 0o777, sha256: sha256(bytes), content: bytes, identity: identity(after) };
  } finally { await handle.close(); }
}

async function git(root, args, limit) {
  const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '--no-pager', '--literal-pathspecs', '-C', root, ...args], {
    encoding: 'buffer', maxBuffer: Math.max(limit, 1024 * 1024), timeout: 60_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

async function gitState(root, limit) {
  const [head, status, index, tree] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD'], limit),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], limit),
    git(root, ['ls-files', '--stage', '-z'], limit),
    git(root, ['ls-tree', '-r', '-z', 'HEAD'], limit),
  ]);
  return { head: head.toString().trim(), statusBase64: status.toString('base64'), indexBase64: index.toString('base64'), treeBase64: tree.toString('base64') };
}

function gitEntries(encoded, index) {
  return Buffer.from(encoded, 'base64').toString('utf8').split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    const header = row.slice(0, tab).split(' ');
    const file = relativePath(row.slice(tab + 1));
    return { path: file, mode: header[0], object: header[index ? 1 : 2], ...(index ? { stage: Number(header[2]) } : {}) };
  });
}

function dirtyPaths(encoded) {
  const rows = Buffer.from(encoded, 'base64').toString('utf8').split('\0');
  const paths = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i]) continue;
    paths.add(relativePath(rows[i].slice(3)));
    if (/[RC]/.test(rows[i].slice(0, 2))) paths.add(relativePath(rows[++i]));
  }
  return paths;
}

async function sourceUniverse(root, policy, tracked, maxFiles) {
  const files = new Set();
  const excluded = new Map();
  const roots = policy.configuredRoots().map(value => {
    if (path.isAbsolute(value)) throw new Error(`Unsafe configured root: ${value}`);
    const normalized = slash(value).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
    return normalized === '.' || normalized === '' ? '.' : relativePath(normalized);
  });
  const inRoots = file => roots.some(base => base === '.' || file === base || file.startsWith(`${base}/`));
  const approve = (file, directory = false) => {
    const decision = policy.explain(file, { directory });
    if (sensitive.test(file) || !decision.included) {
      excluded.set(file, { path: file, reason: sensitive.test(file) ? 'private credential or secret-bearing path' : decision.reason });
      return false;
    }
    return true;
  };
  const add = file => {
    files.add(file);
    if (files.size > maxFiles) throw new Error('File count limit exceeded');
  };
  const walk = async relative => {
    const location = relative === '.' ? root : path.join(root, relative);
    let info;
    try { info = await lstat(location); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) { excluded.set(relative, { path: relative, reason: 'symlink not followed' }); return; }
    if (relative !== '.' && !approve(relative, info.isDirectory())) return;
    if (info.isFile()) { add(relative); return; }
    if (!info.isDirectory()) { excluded.set(relative, { path: relative, reason: 'non-regular file' }); return; }
    if (relative !== '.') {
      const nested = await lstat(path.join(location, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (nested) { excluded.set(relative, { path: relative, reason: 'nested Git repository not archived' }); return; }
    }
    for (const child of (await readdir(location)).sort()) await walk(relative === '.' ? child : `${relative}/${child}`);
  };
  for (const base of roots) await walk(base);
  for (const entry of tracked) {
    if (!inRoots(entry.path) || !approve(entry.path)) continue;
    if (entry.mode === '120000' || entry.mode === '160000') {
      excluded.set(entry.path, { path: entry.path, reason: 'Git symlink or submodule not archived' });
      files.delete(entry.path);
      continue;
    }
    if (entry.stage && entry.stage !== 0) throw new Error(`Unmerged index cannot be reproduced: ${entry.path}`);
    // Include tracked deletions; do not reintroduce excluded symlinks/nested repos.
    if (![...excluded.keys()].some(base => entry.path === base || entry.path.startsWith(`${base}/`))) add(entry.path);
  }
  return { files: [...files].sort(), exclusions: [...excluded.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

async function policyFor(root) {
  // ProjectFilePolicy reads these files while loading; validate them first.
  const inputs = [];
  for (const file of policyInputs) inputs.push(await regular(root, file, defaults.maxFileBytes, true));
  return { policy: await ProjectFilePolicy.load(root), inputs };
}

function storedEntry(entry, kind) {
  const { content, identity, ...result } = entry;
  return { ...result, kind, ...(entry.exists ? { backup: `content/${entry.sha256}` } : {}) };
}

async function readSnapshot(root, artifactPaths, limits) {
  // Bound source and explicitly requested artifact sets independently. Fixed
  // allowlisted policy inputs have their own small, constant upper bound.
  if (artifactPaths.length > limits.maxFiles) throw new Error('File count limit exceeded for artifacts');
  const { policy, inputs } = await policyFor(root);
  const state = await gitState(root, limits.maxTotalBytes);
  const index = gitEntries(state.indexBase64, true);
  const headFiles = gitEntries(state.treeBase64, false);
  const universe = await sourceUniverse(root, policy, [...headFiles, ...index], limits.maxFiles);
  const entries = [];
  let total = 0;
  const configurations = inputs.filter(entry => !universe.files.includes(entry.path)).map(entry => entry.path);
  for (const [kind, files] of [['source', universe.files], ['configuration', configurations], ['artifact', artifactPaths]]) {
    for (const file of files) {
      const entry = await regular(root, file, limits.maxFileBytes, true);
      total += entry.bytes ?? 0;
      if (total > limits.maxTotalBytes) throw new Error('Total byte limit exceeded');
      entries.push({ ...entry, kind });
    }
  }
  const dirty = dirtyPaths(state.statusBase64);
  return { state, universe, entries, index: index.filter(entry => universe.files.includes(entry.path)),
    dirtySourcePaths: universe.files.filter(file => dirty.has(file)), dirtyArtifactPaths: artifactPaths.filter(file => dirty.has(file)), total };
}

function stableSignature(snapshot) {
  return JSON.stringify({ state: snapshot.state, universe: snapshot.universe, entries: snapshot.entries.map(({ content, ...entry }) => entry) });
}

function artifactsFrom(paths = []) {
  return [...new Set(paths.map(relativePath))].sort().map(file => {
    if (!canonical.test(file) || sensitive.test(file)) throw new Error(`Artifact must be an explicitly approved nonsecret canonical GraphWard path: ${file}`);
    return file;
  });
}

async function repositoryRoot(value) {
  if (!value) throw new Error('An explicit repository root is required');
  const root = await realpath(path.resolve(value));
  const top = (await git(root, ['rev-parse', '--show-toplevel'], 1024 * 1024)).toString().trim();
  if (await realpath(top) !== root) throw new Error('Root must be the Git repository top level');
  return root;
}

/** Capture approved bytes, including untracked files/deletions, without Git mutations. */
export async function captureBaseline(options) {
  const root = await repositoryRoot(options.root);
  if (!options.output) throw new Error('An explicit output directory is required');
  const requestedOutput = path.resolve(options.output);
  const output = path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
  if (inside(root, output) || inside(output, root)) throw new Error('Output must be outside the repository and cannot contain it');
  if (await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; })) throw new Error('Refusing to overwrite an existing output');
  const limits = limitsFrom(options);
  const artifactPaths = artifactsFrom(options.artifactPaths);
  const before = await readSnapshot(root, artifactPaths, limits);
  const paths = before.entries.map(entry => entry.path);
  const patch = async cached => {
    const chunks = [];
    let bytes = 0;
    // Bound argv size even when the source universe has many long paths.
    for (let offset = 0; offset < paths.length; offset += 128) {
      const chunk = await git(root, ['diff', ...(cached ? ['--cached', 'HEAD'] : []), '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--', ...paths.slice(offset, offset + 128)], limits.maxTotalBytes);
      bytes += chunk.length;
      if (bytes > limits.maxTotalBytes) throw new Error('Total byte limit exceeded including patches');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const staged = await patch(true);
  const unstaged = await patch(false);
  if (before.total + staged.length + unstaged.length > limits.maxTotalBytes) throw new Error('Total byte limit exceeded including patches');
  const after = await readSnapshot(root, artifactPaths, limits);
  if (stableSignature(before) !== stableSignature(after)) throw new Error('Source or Git state changed during capture; retry when writers are idle');
  const manifest = {
    schemaVersion: 1, createdAt: new Date().toISOString(), root, limits,
    git: { ...before.state, dirty: dirtyPaths(before.state.statusBase64).size > 0, sourceIndex: before.index,
      patches: { staged: { file: 'staged.patch', bytes: staged.length, sha256: sha256(staged) }, unstaged: { file: 'unstaged.patch', bytes: unstaged.length, sha256: sha256(unstaged) } } },
    files: before.entries.map(entry => storedEntry(entry, entry.kind)),
    dirtySourcePaths: before.dirtySourcePaths, dirtyArtifactPaths: before.dirtyArtifactPaths,
    sourceDigest: sha256(JSON.stringify(before.entries.filter(entry => entry.kind !== 'artifact').map(entry => storedEntry(entry, entry.kind)))),
    exclusions: before.universe.exclusions,
    boundaries: ['Git HEAD objects/history must remain available separately.', 'Only policy-approved source, the five fixed policy-input configuration paths, and explicitly listed canonical artifacts are archived.',
      'Excluded files, private credentials, symlinks, nested repositories, dependencies and environment are not reproduced.',
      'Binary patches preserve scoped HEAD-to-index and index-to-worktree changes; untracked bytes and current deletions are in files.',
      'Record the returned manifest digest outside this archive to detect coordinated manifest/receipt tampering.'],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const digest = sha256(manifestBytes);
  await mkdir(output, { mode: 0o700 }); // Exclusive creation; a partial archive is never overwritten.
  await mkdir(path.join(output, 'content'), { mode: 0o700 });
  const written = new Set();
  for (const entry of before.entries) {
    if (!entry.exists || written.has(entry.sha256)) continue;
    await writeFile(path.join(output, 'content', entry.sha256), entry.content, { flag: 'wx', mode: 0o600 });
    written.add(entry.sha256);
  }
  for (const [name, bytes] of [['staged.patch', staged], ['unstaged.patch', unstaged], ['manifest.json', manifestBytes], ['manifest.sha256', `${digest}\n`]]) {
    await writeFile(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  return { output, digest, head: manifest.git.head, sourceFiles: before.universe.files.length, dirtySourcePaths: manifest.dirtySourcePaths, dirtyArtifactPaths: manifest.dirtyArtifactPaths };
}

async function verifiedManifest(baseline, expectedDigest) {
  const directory = await realpath(path.resolve(baseline));
  const manifestEntry = await regular(directory, 'manifest.json', 32 * 1024 * 1024);
  const digest = sha256(manifestEntry.content);
  const receipt = (await regular(directory, 'manifest.sha256', 128)).content.toString().trim();
  if (!/^[a-f0-9]{64}$/.test(receipt) || digest !== receipt || (expectedDigest !== undefined && digest !== expectedDigest)) throw new Error('Baseline manifest digest mismatch');
  const manifest = JSON.parse(manifestEntry.content.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.git?.patches) throw new Error('Unsupported baseline manifest');
  const limits = limitsFrom(manifest.limits ?? {});
  if (manifest.files.filter(entry => entry.kind === 'source').length > limits.maxFiles
    || manifest.files.filter(entry => entry.kind === 'artifact').length > limits.maxFiles
    || manifest.files.filter(entry => entry.kind === 'configuration').length > policyInputs.length) {
    throw new Error('Baseline file count limit exceeded');
  }
  let total = 0;
  const seen = new Set();
  for (const entry of manifest.files) {
    relativePath(entry.path);
    if (seen.has(entry.path) || !['source', 'configuration', 'artifact'].includes(entry.kind) || sensitive.test(entry.path)) throw new Error('Unsafe or duplicate baseline entry');
    seen.add(entry.path);
    if (entry.kind === 'artifact') artifactsFrom([entry.path]);
    if (entry.kind === 'configuration' && !policyInputs.includes(entry.path)) throw new Error('Unsafe configuration path');
    if (!entry.exists) continue;
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || entry.backup !== `content/${entry.sha256}`) throw new Error('Unsafe content backup path');
    const backup = await regular(directory, entry.backup, limits.maxFileBytes);
    total += backup.bytes;
    if (backup.sha256 !== entry.sha256 || backup.bytes !== entry.bytes) throw new Error(`Content backup integrity mismatch: ${entry.path}`);
  }
  for (const [key, file] of [['staged', 'staged.patch'], ['unstaged', 'unstaged.patch']]) {
    const expected = manifest.git.patches[key];
    if (expected?.file !== file) throw new Error('Unsafe patch path');
    const patch = await regular(directory, file, limits.maxTotalBytes);
    total += patch.bytes;
    if (patch.bytes !== expected.bytes || patch.sha256 !== expected.sha256) throw new Error(`Patch integrity mismatch: ${file}`);
  }
  if (total > limits.maxTotalBytes) throw new Error('Baseline total byte limit exceeded');
  const sourceDigest = sha256(JSON.stringify(manifest.files.filter(entry => entry.kind !== 'artifact')));
  if (sourceDigest !== manifest.sourceDigest) throw new Error('Source digest mismatch');
  return { manifest, digest, limits };
}

function difference(expected, actual) {
  if (expected.exists !== actual.exists) return expected.exists ? 'deleted' : 'added';
  if (!expected.exists) return undefined;
  if (expected.sha256 !== actual.sha256) return 'content';
  if (expected.mode !== actual.mode) return 'mode';
  return undefined;
}

/** Verify archive integrity first. paths compares preservation of selected recorded files only. */
export async function checkBaseline({ root: rootInput, baseline, expectedDigest, paths }) {
  if (!baseline) throw new Error('An explicit baseline directory is required');
  const { manifest, digest, limits } = await verifiedManifest(baseline, expectedDigest);
  const root = await repositoryRoot(rootInput);
  const { policy } = await policyFor(root);
  for (const entry of manifest.files) {
    if (entry.kind === 'source' && policy.explain(entry.path).source === 'safety') throw new Error(`Unsafe baseline source path: ${entry.path}`);
  }
  const selected = paths === undefined ? undefined : [...new Set(paths.map(relativePath))].sort();
  if (selected && !selected.length) throw new Error('Preservation paths cannot be empty');
  const recorded = new Map(manifest.files.map(entry => [entry.path, entry]));
  const differences = [];
  let currentState;
  if (selected) {
    for (const file of selected) {
      const expected = recorded.get(file);
      if (!expected) throw new Error(`Preservation path was not captured: ${file}`);
      const actual = await regular(root, file, limits.maxFileBytes, true);
      const reason = difference(expected, actual);
      if (reason) differences.push({ path: file, reason });
    }
    currentState = await gitState(root, limits.maxTotalBytes);
  } else {
    const current = await readSnapshot(root, manifest.files.filter(entry => entry.kind === 'artifact').map(entry => entry.path), limits);
    currentState = current.state;
    const entries = new Map(current.entries.map(entry => [entry.path, entry]));
    for (const [file, expected] of recorded) {
      const reason = difference(expected, entries.get(file) ?? { exists: false });
      if (reason) differences.push({ path: file, reason });
    }
    for (const [file, entry] of entries) if (entry.exists && !recorded.has(file)) differences.push({ path: file, reason: 'added' });
  }
  const headMatches = currentState.head === manifest.git.head;
  const statusMatches = currentState.statusBase64 === manifest.git.statusBase64;
  const indexMatches = currentState.indexBase64 === manifest.git.indexBase64;
  const selectedIndexMatches = !selected || JSON.stringify(gitEntries(currentState.indexBase64, true).filter(entry => selected.includes(entry.path)))
    === JSON.stringify(gitEntries(manifest.git.indexBase64, true).filter(entry => selected.includes(entry.path)));
  const sourceMatches = differences.length === 0;
  return { integrity: true, anchored: expectedDigest !== undefined, digest, comparison: selected ? 'selected-paths' : 'full', headMatches, statusMatches, indexMatches, sourceMatches,
    ...(selected ? { selectedIndexMatches, preserved: sourceMatches && headMatches && selectedIndexMatches } : { unchanged: sourceMatches && headMatches && statusMatches && indexMatches }), differences };
}

async function main(args) {
  const command = args.shift();
  const options = { artifactPaths: [] };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--artifact') options.artifactPaths.push(value);
    else if (key === '--path') (options.paths ??= []).push(value);
    else if (key === '--root') options.root = value;
    else if (key === '--output') options.output = value;
    else if (key === '--baseline') options.baseline = value;
    else if (key === '--expected-digest') options.expectedDigest = value;
    else if (key === '--max-file-bytes') options.maxFileBytes = Number(value);
    else if (key === '--max-total-bytes') options.maxTotalBytes = Number(value);
    else if (key === '--max-files') options.maxFiles = Number(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!['capture', 'check'].includes(command)) throw new Error('Usage: capture --root REPO --output OUTSIDE_REPO [--artifact PATH] | check --root REPO --baseline ARCHIVE [--expected-digest SHA256] [--path PATH]');
  const result = await (command === 'capture' ? captureBaseline(options) : checkBaseline(options));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === 'check' && !(result.preserved ?? result.unchanged)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
