import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectFilePolicy } from '../dist/project-files/index.js';
import { computeProviderSourceSnapshot } from '../dist/providers/workspace.js';
import { buildDependencyGraph, mergeIncrementalUpdate } from '../dist/graph/builders/dependency.js';
import { buildGraph, graphWorkspaceHash, ensureFreshGraph, analyzeImpact, whoCalls, findExecutionPaths } from '../dist/graph/index.js';
import { deriveFacts } from '../dist/claims/derive.js';
import { hashSpan } from '../dist/claims/index.js';
import { extractImports } from '../dist/graph/parsers/imports.js';
import { CounterfactualGraphBranch } from '../dist/simulation/counterfactual-graph.js';
import { HierarchicalGraphPartitioner } from '../dist/graph/partitioning.js';
import { detectCoverageGaps, generateCharacterizationTests } from '../dist/coverage-gap/index.js';
import { getEngineeringContext } from '../dist/context/orchestrator.js';
import { recordEvidenceHashes } from '../dist/evidence/index.js';
import { computeFreshness } from '../dist/freshness/index.js';
import { createConsolidatedRegistry } from '../dist/mcp/consolidated.js';

const fixture = () => mkdtemp(path.join(os.tmpdir(), 'gw-audit-graph-'));
async function write(root, rel, value) { const file=path.join(root,rel); await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,typeof value==='string'?value:JSON.stringify(value)); }
const node = (id, file, metadata={}) => ({id,kind:'symbol',label:id.split('#').at(-1),path:file,confidence:'verified',metadata,evidence:[file+':1']});
const edge = (from,to,metadata={}) => ({from,to,relation:'calls',confidence:'verified',metadata,evidence:['test/a.test.ts:1']});

test('F13 native graphs, derived facts and claim anchors reject outside symlinks', async () => {
  const root=await fixture(), outside=await fixture();
  await write(outside,'private.ts','export const privateValue=1;\n');
  await write(root,'src/a.ts',"import { privateValue } from './escape.js';\nexport const a=privateValue;\n");
  await symlink(path.join(outside,'private.ts'),path.join(root,'src/escape.ts'));
  assert.equal((await (await ProjectFilePolicy.load(root)).explainExisting('src/escape.ts')).included,false);
  const {graph}=await buildDependencyGraph(root);
  assert.ok(!graph.nodes.some(n=>n.kind==='module'&&n.path==='src/escape.ts'&&n.confidence==='verified'));
  assert.ok(!(await deriveFacts(root)).some(f=>f.path==='src/escape.ts'||f.to==='src/escape.ts'));
  assert.equal(await hashSpan(root,{path:'src/escape.ts'}),null);
  assert.ok((await deriveFacts(root)).some(f=>f.path==='src/a.ts'));
});

test('F14 nested ignores govern provider snapshots with rooted negation', async () => {
  const root=await fixture();
  await write(root,'package/.gitignore','local.json\n*.cache\n!keep.cache\nprivate\n!private/kept.ts\n');
  await write(root,'package/local.json','private'); await write(root,'package/drop.cache','drop');
  await write(root,'package/keep.cache','keep'); await write(root,'local.json','public');
  await write(root,'package/private/kept.ts','export const secret=1;');
  const policy=await ProjectFilePolicy.load(root);
  assert.equal((await policy.explainExisting('package/local.json')).included,false);
  assert.equal((await policy.explainExisting('package/keep.cache')).included,true);
  assert.equal((await policy.explainExisting('package/private/kept.ts')).included,false);
  assert.equal(await hashSpan(root,{path:'package/private/kept.ts'}),null);
  const snapshot=await computeProviderSourceSnapshot(root);
  assert.ok(!snapshot.files.some(f=>f.path==='package/local.json'));
  assert.ok(snapshot.files.some(f=>f.path==='local.json'));
});

test('F24 AST import statements preserve type-only locations after side effects', async () => {
  const root=await fixture();
  await write(root,'src/side.ts','export {};'); await write(root,'src/types.ts','export interface Shape { x:number }');
  await write(root,'src/a.ts',"import './side.js';\nimport type { Shape } from './types.js';\nexport const a: Shape={x:1};\n");
  const parsed=await extractImports(path.join(root,'src/a.ts'),root);
  const types=parsed.edges.filter(e=>e.to==='module:src/types');
  assert.equal(types.length,1); assert.equal(types[0].relation,'imports-type');
  assert.deepEqual(types[0].evidence,['src/a.ts:2']);
  assert.ok(parsed.edges.some(e=>e.to==='module:src/side'&&e.relation==='imports'));
});

test('F25/F42 manifest-only changes refresh PEP621 and requirements facts', async () => {
  const root=await fixture(); await write(root,'requirements.txt','requests==2.0\n');
  await write(root,'pyproject.toml','[project]\nname="sample"\ndependencies = [\n "httpx>=0.2", # supported standard array\n "numpy[fast]>=1; python_version >= \'3.8\'",\n]\n');
  await buildGraph(root,{providerEvidence:false});
  const first=await graphWorkspaceHash(root);
  await write(root,'requirements.txt','pandas==2.0\n');
  assert.notEqual(await graphWorkspaceHash(root),first);
  assert.equal((await ensureFreshGraph(root)).refreshed,true);
  const facts=await deriveFacts(root);
  assert.ok(facts.some(f=>f.type==='package-dependency'&&f.name==='httpx'));
  assert.ok(facts.some(f=>f.type==='package-dependency'&&f.name==='numpy'));
  assert.ok(facts.some(f=>f.type==='package-dependency'&&f.name==='pandas'));
  assert.ok(!facts.some(f=>f.type==='package-dependency'&&f.name==='requests'));
  await write(root,'requirements.txt','scipy==2.0\n');
  await buildGraph(root,{update:true,files:['requirements.txt'],providerEvidence:false});
  const updated=JSON.parse(await readFile(path.join(root,'.graphward/graph/dependency-graph.json'),'utf8'));
  assert.ok(updated.nodes.some(n=>n.metadata.declared&&n.label==='scipy'));
  assert.ok(!updated.nodes.some(n=>n.metadata.declared&&n.label==='pandas'));
});

test('F42 TOML comments and unrelated strings cannot become dependency declarations', async () => {
  const root=await fixture();
  for (const header of ['[project]','[project] # valid header comment']) {
  await write(root,'pyproject.toml',`${header}
name="sample"
# dependencies=["commented-dependency"]
description='''
dependencies=["description-dependency"]
[tool.fake]
[project.dependencies]
"legacy-description-dependency"
'''
dependencies = [
  "requests>=2", # array comment
  "sample-url @ https://example.invalid/a.whl#sha256=fixture",
  'numpy>=1; python_version >= "3.8"',
]
[tool.example]
dependencies=["tool-dependency"]
[[tool.example.list]]
dependencies=["list-dependency"]
`);
  const {graph}=await buildDependencyGraph(root);
  const declared=graph.nodes.filter(n=>n.metadata.declared).map(n=>n.label).sort();
  assert.deepEqual(declared,['numpy','requests','sample-url']);
  const url=graph.nodes.find(n=>n.label==='sample-url');
  assert.equal(url.metadata.specifier,'sample-url @ https://example.invalid/a.whl#sha256=fixture');
  assert.ok((await deriveFacts(root)).some(f=>f.type==='package-dependency'&&f.name==='requests'));
  }
});

test('F27/F30 factual queries exclude contested edges and use real test source paths', async () => {
  const root=await fixture(); await write(root,'src/a.ts','export function a(){}'); await write(root,'test/a.test.ts','export function testA(){}');
  const a=node('symbol:src/a#a','src/a'); const t=node('symbol:test/a.test#testA','test/a.test',{isTest:true});
  const graph={schemaVersion:1,graphType:'dependency',generatedAt:new Date().toISOString(),scope:'fixture',nodes:[a,t],edges:[edge(t.id,a.id,{trustState:'contested'})],unknowns:[]};
  await write(root,'.graphward/graph/dependency-graph.json',graph);
  assert.deepEqual((await whoCalls(root,'a')).callers,[]);
  assert.deepEqual(await findExecutionPaths(root,t.id,a.id),[]);
  assert.deepEqual((await analyzeImpact(root,['src/a.ts'])).direct,[]);
  graph.edges=[edge(t.id,a.id)]; await write(root,'.graphward/graph/dependency-graph.json',graph);
  const impact=await analyzeImpact(root,['src/a.ts']);
  assert.deepEqual(impact.testsToRun,['test/a.test.ts']);
});

test('F28 incremental refresh replaces resolved source diagnostics', async () => {
  const root=await fixture(); await write(root,'src/a.ts',"import './missing.js';\n");
  const first=await buildDependencyGraph(root);
  assert.ok(first.graph.unknowns.some(u=>u.includes('missing')));
  await write(root,'src/missing.ts','export {};');
  const update=await buildDependencyGraph(root,{files:['src/a.ts','src/missing.ts'],baseGraph:first.graph});
  const merged=await mergeIncrementalUpdate(first.graph,update.graph,['src/a.ts','src/missing.ts']);
  assert.ok(!merged.unknowns.some(u=>u.includes('unresolved import')));
});

test('F21 task slices account complete serialized payload and disclose minimum overflow', () => {
  const graph={nodes:[node('a','src/a.ts',{details:'x'.repeat(1200)}),node('b','src/b.ts')],edges:[edge('a','b')],unknowns:[]};
  const result=HierarchicalGraphPartitioner.sliceTask(graph,['a'],80,2);
  const estimated=Math.ceil(JSON.stringify(result).length/4);
  assert.equal(result.estimatedTokens,estimated);
  assert.ok(estimated<=80||result.budgetOverflow===true);
});

test('F22 counterfactual validates final endpoints after coherent removals', () => {
  const base={nodes:[{id:'A',path:'a.ts'},{id:'B',path:'b.ts'}],edges:[{from:'A',to:'B'}]};
  assert.deepEqual(CounterfactualGraphBranch.evaluateClosureDelta({},base,{removedNodeIds:['B'],removedEdges:[{from:'A',to:'B'}]}).brokenEdges,[]);
  assert.equal(CounterfactualGraphBranch.evaluateClosureDelta({},base,{addedEdges:[{from:'A',to:'MISSING'}]}).brokenEdges.length,1);
});

test('F37 native exported symbols appear as uncovered helper results', async () => {
  const root=await fixture(); await write(root,'src/a.ts','export function uncovered(){return 7;}');
  const {graph}=await buildDependencyGraph(root);
  assert.ok(detectCoverageGaps(['src/a.ts'],graph).some(g=>g.symbol==='uncovered'));
});

test('F38 generated characterization never swallows unexpected exceptions', async () => {
  const root=await fixture(); await write(root,'package.json',{type:'module'});
  await write(root,'a.mjs','export function alwaysThrows(){throw new Error("unexpected fixture");}');
  const [generated]=generateCharacterizationTests([{file:'a.mjs',symbol:'alwaysThrows',kind:'function',hasTest:false}],root);
  await write(root,generated.testFile,generated.content);
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  let passed=true; try { execFileSync(process.execPath,['--test',generated.testFile],{cwd:root,stdio:'pipe',env}); } catch { passed=false; }
  assert.equal(passed,false,'an absent oracle must be unavailable/skipped or fail; an unexpected throw cannot pass');
});

test('F26 recorded content mismatch blocks timestamp-based freshness claims', async () => {
  const root=await fixture(); await write(root,'src/a.ts','export const a=1;');
  await write(root,'.graphward/knowledge-base/current.md',`# Current\n<!-- freshness: last_checked=${new Date().toISOString()} -->\nA is one (evidence: src/a.ts:1).\n`);
  execFileSync('git',['init','-q'],{cwd:root}); execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base'],{cwd:root});
  await recordEvidenceHashes(root); await write(root,'src/a.ts','export const a=2;');
  const freshness=await computeFreshness(root);
  assert.equal(freshness.driftDecision,'Block implementation');
  assert.ok(freshness.scores.some(s=>s.staleSources.some(source=>source.file==='src/a.ts')));
});

test('F26 scoped annotation review preserves unreviewed knowledge and context', async () => {
  const root=await fixture();
  await write(root,'src/a.ts','export const a=1;'); await write(root,'src/b.ts','export const b=1;');
  await write(root,'.graphward/knowledge-base/a.md','# A\n(evidence: src/a.ts:1)\n');
  await write(root,'.graphward/context/a.md','# A navigation\n(evidence: src/a.ts)\n');
  await write(root,'.graphward/context/b.md','# B navigation\n(evidence: src/b.ts)\n');
  const before=await recordEvidenceHashes(root);
  await write(root,'src/a.ts','export const a=2;'); await write(root,'src/b.ts','export const b=2;');
  await write(root,'.graphward/knowledge-base/a.md','# A changed but unreviewed\n(evidence: src/a.ts:1)\n');
  const after=await recordEvidenceHashes(root,{annotationDocuments:['.graphward/context/a.md']});
  assert.deepEqual(after.documents,before.documents);
  assert.deepEqual(after.hashes,before.hashes);
  assert.deepEqual(after.annotationHashes['.graphward/context/b.md'],before.annotationHashes['.graphward/context/b.md']);
  assert.notDeepEqual(after.annotationHashes['.graphward/context/a.md'],before.annotationHashes['.graphward/context/a.md']);
  const freshness=await computeFreshness(root);
  assert.ok(freshness.scores.find(s=>s.docPath==='.graphward/context/b.md').staleSources.length>0);
  assert.equal(freshness.scores.find(s=>s.docPath==='.graphward/context/a.md').staleSources.length,0);
  await write(root,'README.md','# Not canonical context');
  await assert.rejects(recordEvidenceHashes(root,{annotationDocuments:['README.md']}),/canonical|annotation/i);
  await write(root,'.graphward/context/preparation.json','{}');
  await assert.rejects(recordEvidenceHashes(root,{annotationDocuments:['.graphward/context/preparation.json']}),/canonical|annotation/i);
  const outside=await fixture(); await write(outside,'outside.md','# outside');
  await symlink(path.join(outside,'outside.md'),path.join(root,'.graphward/context/escape.md'));
  await assert.rejects(recordEvidenceHashes(root,{annotationDocuments:['.graphward/context/escape.md']}),/contained|outside|escape/i);
});

test('F20/F29 complete context serialization obeys budget or discloses measured expansion and unknown omissions', async () => {
  const root=await fixture(); await write(root,'.graphward/gw.config.json',{providers:{policy:'native'}});
  await write(root,'src/a.ts','export function a(){return 42;}');
  await buildGraph(root,{providerEvidence:false});
  const graphFile=path.join(root,'.graphward/graph/dependency-graph.json');
  const graph=JSON.parse(await readFile(graphFile,'utf8'));
  graph.unknowns=Array.from({length:25},(_,i)=>`src/a.ts unresolved ${i}: ${'diagnostic '.repeat(50)}`);
  await writeFile(graphFile,JSON.stringify(graph));
  const registry=await createConsolidatedRegistry(root);
  for (const budget of [100,2000,6000]) {
    const pack=await getEngineeringContext(root,{task:'explain a',files:['src/a.ts'],budget});
    const actual=Math.ceil(JSON.stringify(pack).length/4);
    assert.equal(pack.tokenAllocation.used,actual);
    assert.ok(actual<=budget||pack.budgetAccounting?.overflow===true);
    assert.ok(pack.unknownSummary?.total>=25);
    assert.equal(pack.unknownSummary.returned+pack.unknownSummary.omitted,pack.unknownSummary.total);
    assert.doesNotMatch(pack.stopReason,/dependencies.*resolved|paths.*resolved/);
    for (const format of ['json','markdown','full']) {
      const response=await registry.execute('get_engineering_context',{task:'explain a',files:['src/a.ts'],budget,format});
      const measured=Math.ceil(JSON.stringify(response).length/4);
      assert.equal(response.tokenAllocation.used,measured,format+' accounts its final payload');
      assert.equal(response.budgetAccounting.estimatedTokens,measured);
      assert.ok(measured<=budget||response.budgetAccounting.overflow);
    }
  }
});

test('F23 default MCP simulation preserves canonical metadata and resolves executable test paths', async () => {
  const root=await fixture(); await write(root,'.graphward/gw.config.json',{providers:{policy:'native'}});
  await write(root,'src/a.ts','export function a(){return 42;}');
  await write(root,'test/a.test.ts',"import {a} from '../src/a.js'; export function testA(){return a();}");
  await buildGraph(root,{providerEvidence:false});
  const registry=await createConsolidatedRegistry(root);
  const uncovered=await registry.execute('simulate_change_intent',{intent:{filePath:'src/a.ts',action:'modify',description:'modify a'}});
  assert.equal(uncovered.coverage.symbols,'unavailable');
  assert.equal(uncovered.coverage.routes,'unavailable');
  const file=path.join(root,'.graphward/graph/dependency-graph.json'); const graph=JSON.parse(await readFile(file,'utf8'));
  const target=graph.nodes.find(n=>n.id==='symbol:src/a#a');
  target.metadata.symbolId={repository:'fixture',package:'root',language:'typescript',path:'src/a.ts',qualifiedName:'a',declarationHash:'fixture-declaration',origin:'SOURCE'};
  target.metadata.route='GET /a'; await writeFile(file,JSON.stringify(graph));
  const result=await registry.execute('simulate_change_intent',{intent:{filePath:'src/a.ts',action:'modify',description:'modify a'}});
  assert.ok(result.affectedSymbols.some(symbol=>symbol.qualifiedName==='a'));
  assert.ok(result.affectedRoutes.includes('GET /a'));
  assert.deepEqual(result.suggestedTests,['test/a.test.ts']);
  assert.equal(result.coverage.tests,'validated-paths');
});
