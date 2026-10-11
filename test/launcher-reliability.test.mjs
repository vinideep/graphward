import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink, stat, readdir, chmod, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveRuntimeInvocation } from '../dist/runtime/invocation.js';
import { runVerification, coverageFor, changedFiles, writeRecord } from '../dist/verify/index.js';
import { parseGitStatusPaths } from '../dist/verify/git-paths.js';
import { preflight } from '../dist/flight/index.js';
import { runProcess } from '../dist/process/index.js';
import { buildGraph } from '../dist/graph/index.js';
import { mcpServerRegistration } from '../dist/mcp/index.js';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const temp = async (t) => { const root = await mkdtemp(path.join(os.tmpdir(), 'gw-unit-a-')); t.after(() => rm(root, {recursive:true, force:true})); return root; };
const exec = (command, args, cwd, env = {}) => execFileSync(command, args, {cwd, encoding:'utf8', timeout:60000, env:{...process.env,...env}, stdio:['ignore','pipe','pipe']});
async function fixture(t, script='node -e "0"') {
  const root=await temp(t);
  await writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{test:script}}));
  exec('git',['init','-q'],root); exec('git',['config','user.email','test@example.com'],root);exec('git',['config','user.name','Test'],root);
  await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src/a.js'),'export const a=1;\n');
  exec('git',['add','-A'],root);exec('git',['commit','-qm','base'],root);
  return root;
}

test('runtime invocation binds finalized version/bin identity and rejects tampering', async t => {
  const invocation=resolveRuntimeInvocation();
  assert.equal(invocation.command,process.execPath);assert.ok(path.isAbsolute(invocation.args[0]));
  const root=await temp(t);await cp(path.join(checkout,'dist'),path.join(root,'dist'),{recursive:true});await cp(path.join(checkout,'package.json'),path.join(root,'package.json'));
  assert.equal(resolveRuntimeInvocation({packageRoot:root}).entrypointHash,invocation.entrypointHash);
  await writeFile(path.join(root,'dist/cli/index.js'),'#!/usr/bin/env node\nconsole.log("wrong");\n');
  assert.throws(()=>resolveRuntimeInvocation({packageRoot:root}),/does not match/);
});

test('unknown root verbs reject before installation or target writes', async t => {
  const root=await temp(t);
  const result=await runProcess({command:process.execPath,args:[path.join(checkout,'dist/cli/index.js'),'instal',root,'--yes'],cwd:root});
  assert.equal(result.exitCode,1);assert.match(result.stderr,/Unknown command/);assert.deepEqual(await readdir(root),[]);
});

test('Git NUL status preserves newlines, quotes, Unicode, whitespace and both rename paths', async t => {
  assert.deepEqual(parseGitStatusPaths('R  new name\0old name\0 M leading\0'),['new name','old name','leading']);
  const root=await fixture(t);
  const names=['src/space name.js','src/line\nbreak.js','src/"quote".js','src/雪.js','src/ trailing .js'];
  for(const name of names) await writeFile(path.join(root,name),'0');
  exec('git',['mv','src/a.js','src/renamed.js'],root);
  const changed=await changedFiles(root);
  for(const name of [...names,'src/a.js','src/renamed.js']) assert.ok(changed.includes(name),JSON.stringify(changed));
});

test('baseline runs npm test by default; explicit empty impact and explicit empty commands cannot pass', async t => {
  const root=await fixture(t,'node --test test/all.test.mjs');
  await mkdir(path.join(root,'test'));await writeFile(path.join(root,'test/all.test.mjs'),'import test from "node:test";test("real baseline",()=>{});');
  await mkdir(path.join(root,'.graphward/graph'),{recursive:true});await writeFile(path.join(root,'.graphward/graph/dependency-graph.json'),JSON.stringify({nodes:[],edges:[]}));
  const baseline=await runVerification(root,{changedFiles:['src/a.js']});
  assert.equal(baseline.record.verdict,'pass');assert.equal(baseline.record.mode,'baseline');assert.equal(baseline.record.commands[0].command,'npm test');
  assert.equal(baseline.record.provenance,'unknown');assert.equal(baseline.record.provenanceAssurance,'declared');
  const impact=await runVerification(root,{mode:'impact',changedFiles:['src/a.js']});
  assert.equal(impact.record.verdict,'fail');assert.equal(impact.noCommands,true);assert.deepEqual(impact.record.skippedCommands,['npm test']);
  assert.equal((await runVerification(root,{commands:[]})).record.verdict,'fail');
});

test('deletions require executed receipts; non-Git coverage uses hashes even with old mtimes', async t => {
  const root=await fixture(t);await rm(path.join(root,'src/a.js'));
  assert.equal((await coverageFor(root,['src/a.js'])).covered,false);
  const result=await runVerification(root);assert.equal(result.record.files['src/a.js'],'missing');assert.equal(result.record.verdict,'pass');
  assert.equal((await coverageFor(root,['src/a.js'])).covered,true);
  const noGit=await temp(t);await writeFile(path.join(noGit,'a.js'),'first');
  await runVerification(noGit,{commands:['node -e "0"']});await writeFile(path.join(noGit,'a.js'),'second');
  const {utimes}=await import('node:fs/promises');await utimes(path.join(noGit,'a.js'),1,1);
  assert.equal((await coverageFor(noGit,['a.js'])).covered,false);
  await writeRecord(noGit,{schemaVersion:1,createdAt:new Date().toISOString(),commands:[],files:{'a.js':'missing'},gitAvailable:false,verdict:'pass',head:null});
  assert.equal((await coverageFor(noGit,['a.js'])).covered,false);
});

test('verification and preflight never generate product source tests', async t => {
  const root=await fixture(t);await buildGraph(root);
  const before=await readdir(path.join(root,'src'));
  await preflight(root,{intent:'inspect uncovered export',files:['src/a.js']});
  await runVerification(root);
  assert.deepEqual(await readdir(path.join(root,'src')),before);
  assert.deepEqual((await changedFiles(root)).filter(file=>file.endsWith('.js')),[]);
  await writeFile(path.join(root,'src/a.js'),'export const a=2;');
  const result=await runVerification(root,{commands:['node -e "require(\'fs\').writeFileSync(\'src/a.js\',\'changed\')"']});
  assert.equal(result.record.verdict,'fail');assert.ok(result.record.changedDuringChecks.includes('src/a.js'));
});

test('receipts preserve actual timeout and signal failure results', async t => {
  const root=await fixture(t);
  const result=await runVerification(root,{commands:['exec node -e "setInterval(()=>{},1000)"'],timeoutMs:60});
  assert.equal(result.record.verdict,'fail');assert.equal(result.record.commands[0].exitCode,124);assert.equal(result.record.commands[0].timedOut,true);
  const killed=await runProcess({command:process.execPath,args:['-e','process.kill(process.pid,"SIGTERM")']});
  assert.notEqual(killed.exitCode,0);
  const ignoresTerm=await runProcess({command:process.execPath,args:['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],timeoutMs:100});
  assert.equal(ignoresTerm.exitCode,124);assert.equal(ignoresTerm.timedOut,true);
});

test('actual SDK Client initialize/list/call succeeds using identified MCP registration', async t => {
  const root=await temp(t);await mkdir(path.join(root,'.graphward/knowledge-base'),{recursive:true});const registration=JSON.parse(mcpServerRegistration(root)).mcpServers.graphward;
  assert.equal(registration.command,process.execPath);assert.equal(registration.args[1],await realpath(root));assert.ok(!registration.args.includes('-y'));
  const transport=new StdioClientTransport({...registration,stderr:'pipe'});const client=new Client({name:'unit-a-client',version:'1.0.0'});
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version,JSON.parse(await readFile(path.join(checkout,'package.json'),'utf8')).version);
    assert.equal(client.getServerCapabilities().experimental.graphward.apiVersion,'2.2');
    const listed=await client.listTools();assert.ok(listed.tools.some(tool=>tool.name==='provider_status'));
    const result=await client.callTool({name:'read_knowledge',arguments:{root}});assert.ok(!result.isError);
  } finally {await client.close();}
});

test('source rebuild/link and packed prepare keep all declared bins executable without a compiler in the package', {timeout:60000}, async t => {
  const root=await temp(t);const source=path.join(root,'source');await mkdir(source);
  for(const name of ['src','scripts','tsconfig.json','package.json']) await cp(path.join(checkout,name),path.join(source,name),{recursive:true});
  await symlink(path.join(checkout,'node_modules'),path.join(source,'node_modules'),'dir');
  const pkg=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
  // The isolated link tests bin/lifecycle behavior, without installing optional peers.
  delete pkg.dependencies;delete pkg.peerDependencies;delete pkg.peerDependenciesMeta;
  await writeFile(path.join(source,'package.json'),JSON.stringify(pkg,null,2));
  const prefix=path.join(root,'prefix');const env={npm_config_prefix:prefix,npm_config_cache:path.join(root,'cache')};
  exec('npm',['link','--offline','--no-audit','--no-fund'],source,env);
  for(const relative of new Set(Object.values(pkg.bin))) assert.ok((await stat(path.join(source,relative))).mode & 0o111);
  assert.match(exec(path.join(prefix,'bin/gw'),['--help'],root),/Core commands/);
  await chmod(path.join(source,'dist/cli/index.js'),0o644);
  exec('npm',['run','build'],source,env);
  assert.match(exec(path.join(prefix,'bin/gw'),['--help'],root),/Core commands/);
  const retained=await readFile(path.join(source,'dist/cli/index.js'),'utf8');
  await writeFile(path.join(source,'src/failed-build-regression.ts'),'const invalid: number = "compile failure";');
  assert.throws(()=>exec('npm',['run','build'],source,env),/Build failed|compile failure|not assignable/);
  assert.equal(await readFile(path.join(source,'dist/cli/index.js'),'utf8'),retained);
  assert.match(exec(path.join(prefix,'bin/gw'),['--help'],root),/Core commands/);
  await rm(path.join(source,'src/failed-build-regression.ts'));
  const packed=JSON.parse(exec('npm',['pack','--json','--offline'],source,env));
  const installed=path.join(root,'installed');await mkdir(installed);
  exec('npm',['install',path.join(source,packed[0].filename),'--offline','--omit=dev','--no-audit','--no-fund'],installed,env);
  const packageRoot=path.join(installed,'node_modules/graphward');
  // Runtime dependencies are preinstalled in this offline lifecycle fixture.
  // The tarball itself still has no source or development compiler.
  await symlink(path.join(checkout,'node_modules/@modelcontextprotocol'),path.join(installed,'node_modules/@modelcontextprotocol'),'dir');
  exec('npm',['run','prepare'],packageRoot,env);
  assert.match(exec(path.join(installed,'node_modules/.bin/gw'),['--help'],root),/Core commands/);
  assert.equal(resolveRuntimeInvocation({packageRoot}).version,pkg.version);
  assert.ok(!(await readdir(packageRoot)).includes('src'));
  for(const relative of new Set(Object.values(pkg.bin))) assert.ok((await stat(path.join(packageRoot,relative))).mode & 0o111);
});
