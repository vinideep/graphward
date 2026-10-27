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


test('unrepresentable provider endpoints are quarantined with original evidence and dry runs do not write',async t=>{
 const root=await fixture(t);
 const rawEdge={source:'fresh',target:'unknown',relation:'calls',confidence:'EXTRACTED',customEvidence:{original:true}};
 const rawTarget={id:'unknown',label:'externalThing',customIdentity:'preserve-me'};
 const runner=async request=>{
  if(request.args?.[0]==='--version')return response(request,'graphify 0.9.29');
  if(request.args?.[0]==='extract'){const output=request.args[request.args.indexOf('--out')+1];await writeFile(path.join(output,'graph.json'),JSON.stringify({nodes:[{id:'fresh',label:'context',source_file:'src/code.ts'},rawTarget],edges:[rawEdge]}));return response(request);}
  return response(request,'',1);
 };
 assert.equal((await runGraphifyExtraction(root,{runner,providerHome:path.join(root,'home')})).ok,true);
 const native=await buildDependencyGraph(root);
 const result=await reconcileGraphifyEvidence(root,native.graph);
 const ids=new Set(result.graph.nodes.map(node=>node.id));
 assert.ok(result.graph.edges.every(edge=>ids.has(edge.from)&&ids.has(edge.to)),'canonical edges must have both endpoints');
 assert.equal(result.quarantinedEvidence.length,1);
 assert.deepEqual(result.quarantinedEvidence[0].rawEdge,rawEdge);
 assert.deepEqual(result.quarantinedEvidence[0].rawTarget,rawTarget);
 assert.match(result.quarantinedEvidence[0].reason,/endpoint/);
 const {buildGraph}=await import('../dist/graph/index.js');
 await buildGraph(root,{write:false});
 const reportPath=path.join(root,'.graphward/reports/provider-evidence-quarantine.json');
 await assert.rejects(readFile(reportPath));
 await buildGraph(root);
 const report=JSON.parse(await readFile(reportPath,'utf8'));
 assert.equal(report.quarantinedEvidence.length,1);
 assert.deepEqual(report.quarantinedEvidence[0].rawEdge,rawEdge);
 assert.ok(report.graphHash);
 assert.equal(report.provenance.providerVersion,'0.9.29');
 assert.ok(report.provenance.sourceHashes['src/code.ts']);
});


test('quarantine retains valid relations, stale/missing/excluded endpoints and repeated builds remain idempotent',async t=>{
 const root=await fixture(t);
 await writeFile(path.join(root,'src/target.ts'),'export const target = true;');
 const edges=[{source:'fresh',target:'valid',relation:'calls'},{source:'missing',target:'valid',relation:'calls'},{source:'fresh',target:'missing',relation:'calls'},{source:'fresh',target:'excluded',relation:'calls'},{source:'fresh',target:'valid',relation:'uses',source_file:'/outside/evidence.ts'}];
 const runner=async request=>{
  if(request.args?.[0]==='--version')return response(request,'graphify 0.9.29');
  if(request.args?.[0]==='extract'){const output=request.args[request.args.indexOf('--out')+1];await writeFile(path.join(output,'graph.json'),JSON.stringify({nodes:[{id:'fresh',label:'context',source_file:'src/code.ts'},{id:'valid',label:'target',source_file:'src/target.ts'},{id:'excluded',label:'excluded',source_file:'/outside/path.ts'}],edges}));return response(request);}
  return response(request,'',1);
 };
 await runGraphifyExtraction(root,{runner,providerHome:path.join(root,'home')});
 const native=await buildDependencyGraph(root);
 const first=await reconcileGraphifyEvidence(root,native.graph);
 const second=await reconcileGraphifyEvidence(root,native.graph);
 assert.equal(first.quarantinedEvidence.length,4);
 assert.deepEqual(first.quarantinedEvidence,second.quarantinedEvidence);
 assert.ok(first.graph.edges.some(edge=>edge.metadata.provider==='graphify'));
 assert.equal(new Set(first.graph.nodes.map(node=>node.id)).size,first.graph.nodes.length);
 await writeFile(path.join(root,'src/target.ts'),'export const target = false;');
 const stale=await reconcileGraphifyEvidence(root,(await buildDependencyGraph(root)).graph);
 assert.ok(stale.quarantinedEvidence.some(item=>item.rawEdge.target==='valid'&&/stale/.test(item.reason)));
});
