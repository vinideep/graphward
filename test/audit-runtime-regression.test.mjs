import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeInvocation } from '../dist/runtime/invocation.js';
import { execFileSync } from 'node:child_process';
const checkout = fileURLToPath(new URL('../', import.meta.url));

test('F33 finalized runtime identity rejects transitive implementation drift', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'gw-runtime-generation-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await cp(path.join(checkout, 'dist'), path.join(root, 'dist'), {recursive:true});
  await cp(path.join(checkout, 'package.json'), path.join(root, 'package.json'));
  const initial = resolveRuntimeInvocation({packageRoot:root});
  const isolatedRuntime = await import(new URL('file://' + path.join(root,'dist/runtime/invocation.js')).href);
  assert.equal(isolatedRuntime.runtimeIdentityStatus().current,true);
  const module = path.join(root, 'dist/telemetry/index.js');
  await writeFile(module, (await readFile(module, 'utf8')) + '\n// transitive drift\n');
  assert.throws(() => resolveRuntimeInvocation({packageRoot:root}), /implementation|generation|does not match/);
  assert.equal(isolatedRuntime.runtimeIdentityStatus().current,false);
  assert.match(initial.generation, /^[a-f0-9]{64}$/);
});

test('F44 shell quoting transports hostile-looking path names literally', async () => {
  const {quoteShellArgument} = await import('../dist/runtime/invocation.js');
  const literal = "install $HOME $(printf expanded) `printf expanded` 'quoted' path";
  const command = ['printf','%s',literal].map(value=>quoteShellArgument(value,'darwin')).join(' ');
  assert.equal(execFileSync('/bin/sh',['-c',command],{encoding:'utf8'}),literal);
  assert.throws(()=>quoteShellArgument('C:\\unsafe%PATH%','win32'),/unsupported/);
});

test('F45 README candidate version matches package metadata without claiming publication', async () => {
  const pkg = JSON.parse(await readFile(path.join(checkout,'package.json'),'utf8'));
  const readme = await readFile(path.join(checkout,'README.md'),'utf8');
  assert.ok(readme.includes(`package version \`${pkg.version}\``));
  assert.match(readme,/not a published release/);
});
