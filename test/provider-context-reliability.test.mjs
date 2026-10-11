import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runGraphifyExtraction} from '../dist/providers/graphify.js';
import {prepareTaskContext} from '../dist/context/preparation.js';
import {inspectProjectProviderRuns} from '../dist/providers/project-status.js';
import {searchCodeContext} from '../dist/providers/cce.js';
import {buildDependencyGraph} from '../dist/graph/builders/dependency.js';
import {reconcileGraphifyEvidence} from '../dist/graph/provider-evidence.js';
async function fixture(t,requireProviders=false) {const root=await realpath(await mkdtemp(path.join(tmpdir(),'gw-provider-test-')));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'src'));await mkdir(path.join(root,'.graphward'));await writeFile(path.join(root,'src/code.ts'),'export const context = true;');await writeFile(path.join(root,'.graphward/gw.config.json'),JSON.stringify({providers:{policy:'auto',requireProviders}}));return root;}
const response = (request,stdout='',exitCode=0) => ({command:request.command,args:request.args??[],stdout,stderr:'',exitCode,timedOut:false});
test('repeated Graphify refresh activates only fresh nested output and keeps staging source paths usable',async t=>{
 const root=await fixture(t);let generation=0;
 const runner=async request=>{
  if(request.args?.[0]==='--version')return response(request,'graphify 0.9.29');
  if(request.args?.[0]==='extract') {assert.ok(request.args.includes('--no-gitignore'),'ancestor provider-cache ignore rules must not hide approved nested sources');generation++;const output=request.args[request.args.indexOf('--out')+1];await mkdir(path.join(output,'graphify-out'));await writeFile(path.join(output,'graphify-out/graph.json'),JSON.stringify({nodes:[{id:`current-${generation}`,label:`generation-${generation}`,source_file:path.join(request.args[1],'src/code.ts')}],edges:[]}));return response(request);}
  return response(request,'',1);
 };
 assert.equal((await runGraphifyExtraction(root,{runner,providerHome:path.join(root,'home')})).ok,true);
 assert.equal((await runGraphifyExtraction(root,{runner,providerHome:path.join(root,'home')})).ok,true);
 const graph=JSON.parse(await readFile(path.join(root,'.graphward/providers/graphify/graph.json'),'utf8'));assert.equal(graph.nodes[0].id,'current-2');assert.equal(graph.nodes[0].source_file,'src/code.ts');
 const native=await buildDependencyGraph(root);const reconciled=await reconcileGraphifyEvidence(root,native.graph);assert.ok(reconciled.graph.nodes.some(node=>node.metadata?.providers?.includes('graphify')||node.metadata?.provider==='graphify'));
 const manifest=JSON.parse(await readFile(path.join(root,'.graphward/providers/graphify/run.json'),'utf8'));assert.equal(manifest.projectRoot,root);
 await writeFile(path.join(root,'.graphward/providers/graphify/graph.json'),JSON.stringify({nodes:[],edges:[]}));assert.equal((await inspectProjectProviderRuns(root))[0].health,'invalid');assert.equal((await reconcileGraphifyEvidence(root,native.graph)).rejectedEvidence,1);
});
test('source edits during extraction never activate output with a mismatched generation',async t=>{
 const root=await fixture(t);const runner=async request=>{
 if(request.args?.[0]==='--version')return response(request,'graphify 0.9.29');
 if(request.args?.[0]==='extract'){const output=request.args[request.args.indexOf('--out')+1];await writeFile(path.join(output,'graph.json'),JSON.stringify({nodes:[],edges:[]}));await writeFile(path.join(root,'src/code.ts'),'export const changed = true;');return response(request);}return response(request,'',1);};
 assert.equal((await runGraphifyExtraction(root,{runner,providerHome:path.join(root,'home')})).ok,false);await assert.rejects(readFile(path.join(root,'.graphward/providers/graphify/run.json')));
});
test('required missing providers block recovery and retrieval; cancelled preparation cannot become ready',async t=>{
 const root=await fixture(t,true);let invocations=0;const runner=async request=>{invocations++;return response(request,'',1);};
 const receipt=await prepareTaskContext(root,{runner,providerHome:path.join(root,'home')});assert.equal(receipt.status,'blocked');const calls=invocations;assert.equal((await prepareTaskContext(root,{runner,providerHome:path.join(root,'home')})).id,receipt.id);assert.equal(invocations,calls,'failed generation has one recovery attempt unless explicitly retried');
 await assert.rejects(searchCodeContext(root,'context',['src'],{runner,providerHome:path.join(root,'home')}),/Required CCE/);
 const signal=new AbortController();signal.abort();const cancelled=await prepareTaskContext(root,{runner,providerHome:path.join(root,'home'),retry:true,signal:signal.signal});assert.equal(cancelled.status,'cancelled');
});
