import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, utimes } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { proposeTask, loadTask, confirmationChallenge, observeUserPrompt, checkTaskReadiness, bindTaskContext, recordTaskChangeMapping, confirmTaskInteractively, scopeMatches } from '../dist/aidlc/task-contract.js';
import { prepareTaskContext } from '../dist/context/preparation.js';
import { getEngineeringContext } from '../dist/context/orchestrator.js';
import { assessPromptClarity, freezeRequirements } from '../dist/aidlc/clarification.js';
import { createConsolidatedRegistry } from '../dist/mcp/consolidated.js';
import { runHook, normalizeInput } from '../dist/hooks/index.js';
import { acquireLock } from '../dist/manifest/lock.js';
import { recordEvidenceHashes, checkEvidenceHashes } from '../dist/evidence/index.js';
import { buildGraph, loadExistingGraph } from '../dist/graph/index.js';
const contract = () => ({ kind: 'feature', request: 'Create a searchable project index', intendedUsers: ['developers'], behavior: ['Search indexes current source'], nonGoals: ['Cloud sync'], acceptanceCriteria: ['Current files appear in search'], scope: ['src', 'test'], constraints: ['Local only'], questions: [{id:'scope', question:'Confirm developer search with local source and no cloud sync?', options:[], answer:'Yes'}] });
async function fixture(t) { const root=await realpath(await mkdtemp(path.join(tmpdir(),'gw-task-test-')));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'.graphward'),{recursive:true});await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src/index.ts'),'export const searchable = true;\n');await writeFile(path.join(root,'.graphward/gw.config.json'),JSON.stringify({providers:{policy:'native'}}));return root; }
const propose = (root, taskId='search', sessionId='conversation') => proposeTask(root,contract(),{taskId,host:'codex',sessionId});
test('long vague features clarify; exact typo and JWT fixes avoid irrelevant questions',()=>{
 assert.ok(assessPromptClarity('Create a new feature that makes our product much more useful and efficient for everyone using the system every day').questions.length);
 assert.equal(assessPromptClarity('Fix typo in README.md').questions.length,0);
 assert.ok(!assessPromptClarity('Fix JWT expiration in src/auth.ts').questions.some(q=>/strategy/i.test(q.question)));
});
test('proposal cannot approve itself; actual native prompt binds exact task revision and independent sessions',async t=>{
 const root=await fixture(t);const first=await propose(root);await propose(root,'other','other-session');
 assert.equal((await checkTaskReadiness(root,{taskId:'search',stage:'requirements'})).ready,false);
 assert.equal((await observeUserPrompt(root,'codex','conversation','Plan approved')).confirmed,false);
 assert.equal((await observeUserPrompt(root,'codex','other-session',first.challenge)).confirmed,false);
 assert.equal((await observeUserPrompt(root,'codex','conversation',first.challenge)).confirmed,true);
 assert.equal((await checkTaskReadiness(root,{taskId:'search',stage:'requirements'})).ready,true);
 assert.equal((await checkTaskReadiness(root,{taskId:'other',stage:'requirements'})).ready,false);
 const next=contract();next.behavior.push('New compatibility contract');next.questions[0].answer=undefined;
 const revised=await proposeTask(root,next,{taskId:'search'});assert.equal(revised.task.confirmation,undefined);assert.equal(revised.task.contract.questions[0].answer,'Yes');assert.equal(revised.task.revision,2);
 assert.equal((await observeUserPrompt(root,'codex','conversation',first.challenge)).confirmed,false);
});
test('current context is required; in-scope task edits keep context, out-of-scope drift invalidates it; preparation is model-free',async t=>{
 const root=await fixture(t);const task=await propose(root);await observeUserPrompt(root,'codex','conversation',task.challenge);
 assert.equal((await checkTaskReadiness(root,{taskId:'search'})).ready,false);
 const preparation=await prepareTaskContext(root,{runner:async()=>{throw Error('Native policy must not invoke providers');}});assert.equal(preparation.status,'ready');assert.equal(preparation.binaries.length,0);
 await bindTaskContext(root,'search');assert.equal((await checkTaskReadiness(root,{taskId:'search',files:['src/index.ts']})).ready,true);
 assert.equal((await checkTaskReadiness(root,{taskId:'search',files:['outside.ts']})).ready,false);
 // The task's own edits inside its confirmed scope must not lock the agent out of its next edit.
 await writeFile(path.join(root,'src/index.ts'),'export const searchable = false;');await writeFile(path.join(root,'src/added.ts'),'export const added = 1;');
 assert.ok((await loadTask(root,'search')).confirmation);assert.equal((await checkTaskReadiness(root,{taskId:'search'})).ready,true);
 // Anything outside the confirmed scope changing means the bound context no longer describes the code.
 await writeFile(path.join(root,'outside.ts'),'export const external = true;');
 const drifted=await checkTaskReadiness(root,{taskId:'search'});assert.equal(drifted.ready,false);assert.ok(drifted.blockers.some(blocker=>/outside the confirmed scope changed/.test(blocker)&&blocker.includes('outside.ts')));
 await prepareTaskContext(root);await bindTaskContext(root,'search');assert.equal((await checkTaskReadiness(root,{taskId:'search'})).ready,true);
});
test('scope entries accept prefixes and globs without widening to siblings',()=>{
 assert.ok(scopeMatches('src','src/a/b.ts'));assert.ok(scopeMatches('src/','src/a.ts'));assert.ok(!scopeMatches('src','srcx/a.ts'));
 assert.ok(scopeMatches('src/**','src/aidlc/task-contract.ts'));assert.ok(!scopeMatches('src/**','test/a.ts'));
 assert.ok(scopeMatches('**/*.md','docs/guide/a.md'));assert.ok(scopeMatches('**/*.md','README.md'));assert.ok(!scopeMatches('*.md','docs/a.md'));
 assert.ok(scopeMatches('./README.md','README.md'));assert.ok(!scopeMatches('src/*.ts','src/a/b.ts'));
});
test('unconfirmed proposals explain how the user confirms them',async t=>{
 const root=await fixture(t);const proposed=await propose(root);
 assert.ok(Array.isArray(proposed.howToConfirm));assert.ok(proposed.howToConfirm.some(step=>step.includes('Approve scope')&&step.includes(proposed.challenge)));
 await observeUserPrompt(root,'codex','conversation',proposed.challenge);assert.equal((await propose(root)).howToConfirm,undefined);
});
test('read-only context neither creates nor refreshes project artifacts and rejects a different MCP project',async t=>{
 const root=await fixture(t);await prepareTaskContext(root);const graphPath=path.join(root,'.graphward/graph/dependency-graph.json');const before=await readFile(graphPath,'utf8');await writeFile(path.join(root,'src/index.ts'),'export const changed = true;');
 const context=await getEngineeringContext(root,{task:'Inspect index',files:['src/index.ts']},{runner:async()=>{throw Error('Native policy invoked provider');}});assert.equal(await readFile(graphPath,'utf8'),before);assert.ok(context.unknowns.some(value=>/stale/i.test(value)));assert.equal(context.providerContribution.cceAccepted,0);
 const registry=await createConsolidatedRegistry(root);await assert.rejects(registry.execute('get_engineering_context',{root:path.dirname(root),task:'Inspect index'}),/another project/);
 await assert.rejects(registry.execute('propose_task_contract',{contract:contract(),approved:true}),/approved|Unknown|additional/i);
});
test('managed edit hooks block missing task, malformed state and shell/patch targets; nested Cursor/Antigravity payloads survive',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'.graphward/install-manifest.json'),'{}');
 for(const input of [{tool_name:'Bash',tool_input:{command:'touch src/index.ts'}},{tool_name:'apply_patch',tool_input:{command:'*** Begin Patch\n*** Update File: src/index.ts\n*** End Patch'}},{}]) assert.equal(JSON.parse((await runHook('pre-tool-use',root,{session_id:'conversation',...input},'codex')).stdout).hookSpecificOutput.permissionDecision,'deny');
 const nested=normalizeInput('cursor',JSON.stringify({conversation_id:'conversation',tool_name:'Write',tool_input:{file_path:path.join(root,'src/index.ts')}}));assert.equal(nested.tool_input.file_path,path.join(root,'src/index.ts'));
 const agy=normalizeInput('antigravity',JSON.stringify({conversationId:'conversation',workspacePaths:[root],toolCall:{name:'write_to_file',args:{TargetFile:path.join(root,'src/index.ts')}}}));assert.equal(agy.tool_input.file_path,path.join(root,'src/index.ts'));
 const task=await propose(root);await writeFile(path.join(root,'.graphward/aidlc/tasks/search.json'),'{ broken');assert.equal(JSON.parse((await runHook('pre-tool-use',root,{session_id:'conversation',tool_name:'Write',tool_input:{file_path:path.join(root,'src/index.ts')}},'codex')).stdout).hookSpecificOutput.permissionDecision,'deny');
});
test('empty/letter-only requirements and forged confirmation assurance cannot authorize tasks',async t=>{
 const root=await fixture(t);await assert.rejects(freezeRequirements(root,'Search',[]));await assert.rejects(freezeRequirements(root,'Search',[{questionId:'Q1',selectedOptionId:'A'}]));
 const {task}=await propose(root);task.confirmation={source:'host-user-prompt',assurance:'host-observed',quote:'Assistant says approved',eventHash:'fake',revisionHash:task.revisionHash};await writeFile(path.join(root,'.graphward/aidlc/tasks/search.json'),JSON.stringify(task));assert.equal((await checkTaskReadiness(root,{taskId:'search',stage:'requirements'})).ready,false);
 await assert.rejects(confirmTaskInteractively(root,'search',{host:'antigravity',sessionId:'session'}),/interactive terminal/);
});
test('change mapping covers every requirement and rejects unrelated additions',async t=>{
 const root=await fixture(t);const task=await propose(root);await observeUserPrompt(root,'codex','conversation',task.challenge);
 await assert.rejects(recordTaskChangeMapping(root,'search',[]),/Every acceptance/);
 await assert.rejects(recordTaskChangeMapping(root,'search',[{criterion:contract().acceptanceCriteria[0],files:['outside.ts'],tests:['npm test'],rationale:'Speculative change'}]),/outside/);
 assert.ok((await recordTaskChangeMapping(root,'search',[{criterion:contract().acceptanceCriteria[0],files:['src/index.ts'],tests:['npm test'],rationale:'Search current source'}])).changeMapping);
});
test('old live locks cannot be stolen and delayed release preserves a replacement owner',async t=>{
 const root=await fixture(t);const release=await acquireLock(root);const location=path.join(root,'.graphward/.lock');await utimes(location,1,1);await assert.rejects(acquireLock(root,{timeoutMs:20,retryIntervalMs:5}),/not proven dead/);
 const replacement=JSON.stringify({pid:process.pid,hostname:hostname(),token:'replacement'});await writeFile(location,replacement);await release();assert.equal(await readFile(location,'utf8'),replacement);
});
test('knowledge verification is per-document and binds complete cited bytes, not an unchanged line',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,'.graphward/knowledge-base'));const kb=path.join(root,'.graphward/knowledge-base');await writeFile(path.join(kb,'indexed.md'),'# Indexed\n`src/index.ts:1`');await writeFile(path.join(kb,'uncited.md'),'# Uncited\nUnproved statements');
 assert.equal((await checkEvidenceHashes(root)).results[0].status,'unrecorded');await recordEvidenceHashes(root);let report=await checkEvidenceHashes(root);assert.equal(report.documents.find(d=>d.path.endsWith('indexed.md')).verified,true);assert.equal(report.documents.find(d=>d.path.endsWith('uncited.md')).verified,false);
 await writeFile(path.join(root,'src/index.ts'),'export const searchable = true;\nexport const contractChanged = true;');report=await checkEvidenceHashes(root);assert.equal(report.results[0].status,'ok');assert.equal(report.documents.find(d=>d.path.endsWith('indexed.md')).verified,false);
});
test('normal graph extraction resolves aliases and project references using compiler configuration',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@app/*':['src/*']}}}));await writeFile(path.join(root,'src/use.ts'),'import { searchable } from "@app/index"; export const result = searchable;');await buildGraph(root);const graph=await loadExistingGraph(path.join(root,'.graphward/graph/dependency-graph.json'));assert.ok(graph.edges.some(edge=>edge.from==='module:src/use'&&edge.to==='module:src/index'&&edge.relation==='imports'));
});

test('Claude native question confirmation records the full question and observed answer',async t=>{
 const root=await fixture(t);const proposed=await proposeTask(root,contract(),{taskId:'native',host:'claude-code',sessionId:'native-session'});
 const question=`Confirm the reviewed requirements. ${proposed.challenge}`;
 const input={session_id:'native-session',tool_name:'AskUserQuestion',tool_input:{questions:[{question,options:[{label:'Approve scope',description:'Proceed with the displayed revision'},{label:'Revise scope',description:'Change requirements first'}]}]},tool_response:{answers:{[question]:'Approve scope'}}};
 await runHook('post-tool-use',root,input,'claude-code');assert.equal((await checkTaskReadiness(root,{taskId:'native',stage:'requirements'})).ready,true);assert.equal((await loadTask(root,'native')).confirmation.source,'host-question-response');
});

test('Claude native confirmation accepts the challenge as the selected label or a recommended approval label, and rejects other answers',async t=>{
 const root=await fixture(t);
 const ask=(sessionId,question,options,answer)=>runHook('post-tool-use',root,{session_id:sessionId,tool_name:'AskUserQuestion',tool_input:{questions:[{question,options:options.map(label=>({label,description:''}))}]},tool_response:{answers:{[question]:answer}}},'claude-code');
 const byLabel=await proposeTask(root,contract(),{taskId:'label',host:'claude-code',sessionId:'s-label'});
 await ask('s-label','Approve this task?',[byLabel.challenge,'Reject'],byLabel.challenge);
 assert.equal((await checkTaskReadiness(root,{taskId:'label',stage:'requirements'})).ready,true);
 const recommended=await proposeTask(root,contract(),{taskId:'recommended',host:'claude-code',sessionId:'s-rec'});
 await ask('s-rec',`Review: ${recommended.challenge}`,['Approve scope (Recommended)','Reject'],'Approve scope (Recommended)');
 assert.equal((await checkTaskReadiness(root,{taskId:'recommended',stage:'requirements'})).ready,true);
 const rejected=await proposeTask(root,contract(),{taskId:'rejected',host:'claude-code',sessionId:'s-rej'});
 await ask('s-rej',`Review: ${rejected.challenge}`,['Approve scope','Reject'],'Reject');
 await ask('s-rej','Approve?',['Approve scope','Reject'],'Approve scope'); // approval label without the challenge
 assert.equal((await checkTaskReadiness(root,{taskId:'rejected',stage:'requirements'})).ready,false);
});

test('confirmed task requirements are reused on resume; changed feature intent still asks',async t=>{
 const root=await fixture(t);const first=await propose(root);await observeUserPrompt(root,'codex','conversation',first.challenge);
 const registry=await createConsolidatedRegistry(root);
 const resumed=await registry.execute('assess_prompt_clarity',{taskId:'search',prompt:'continue'});
 assert.equal(resumed.mustClarify,false);assert.equal(resumed.confirmedTask,'search');
 const changed=await registry.execute('assess_prompt_clarity',{taskId:'search',prompt:'Create a new cloud synchronization feature'});
 assert.equal(changed.mustClarify,true);
});

test('scoped knowledge refresh cannot certify unreviewed documents sharing source citations',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,'.graphward/knowledge-base'));
 const first='.graphward/knowledge-base/reviewed.md',other='.graphward/knowledge-base/old.md';
 await writeFile(path.join(root,first),'Reviewed behavior `src/index.ts:1`');await writeFile(path.join(root,other),'Old behavior `src/index.ts:1`');await recordEvidenceHashes(root);
 await writeFile(path.join(root,'src/index.ts'),'export const searchable = true;\nexport const newBehavior = true;');
 await writeFile(path.join(root,first),'Updated behavior `src/index.ts:1`');await recordEvidenceHashes(root,{documents:[first]});
 const report=await checkEvidenceHashes(root);assert.equal(report.documents.find(doc=>doc.path===first).verified,true);assert.equal(report.documents.find(doc=>doc.path===other).verified,false);
});

test('switching provider policy invalidates context without revoking approved intent',async t=>{
 const root=await fixture(t);const first=await propose(root);await observeUserPrompt(root,'codex','conversation',first.challenge);await prepareTaskContext(root);await bindTaskContext(root,'search');
 await writeFile(path.join(root,'.graphward/gw.config.json'),JSON.stringify({providers:{policy:'auto',requireProviders:true}}));
 const readiness=await checkTaskReadiness(root,{taskId:'search'});assert.equal(readiness.ready,false);assert.ok(readiness.blockers.some(blocker=>/policy changed/.test(blocker)));assert.ok((await loadTask(root,'search')).confirmation);
});

test('Antigravity wrapped GraphWard reads pass discovery while mutating MCP calls remain gated',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'.graphward/install-manifest.json'),'{}');
 const input=normalizeInput('antigravity',JSON.stringify({conversationId:'conversation',workspacePaths:[root],toolCall:{name:'call_mcp_tool',args:{ServerName:'graphward',ToolName:'get_engineering_context',Arguments:{task:'Inspect source'}}}}));
 assert.equal(input.tool_name,'mcp__graphward__get_engineering_context');assert.equal(input.tool_input.task,'Inspect source');assert.equal((await runHook('pre-tool-use',root,input,'antigravity')).stdout,undefined);
 const mutation=normalizeInput('antigravity',JSON.stringify({conversationId:'conversation',workspacePaths:[root],toolCall:{name:'call_mcp_tool',args:{ServerName:'external',ToolName:'mutate',Arguments:{}}}}));assert.equal(JSON.parse((await runHook('pre-tool-use',root,mutation,'antigravity')).stdout).decision,'deny');
});

test('MCP context responses stay compact: no duplicated rendering by default, compact preparation receipt',async t=>{
 const root=await fixture(t);const proposed=await proposeTask(root,contract(),{taskId:'mcp',host:'codex',sessionId:'mcp-session'});await observeUserPrompt(root,'codex','mcp-session',proposed.challenge);
 const registry=await createConsolidatedRegistry(root);
 const structured=await registry.execute('get_engineering_context',{task:'Inspect index',files:['src/index.ts']});
 assert.equal(structured.markdown,undefined);assert.ok(structured.code);
 const rendered=await registry.execute('get_engineering_context',{task:'Inspect index',format:'markdown'});
 assert.equal(typeof rendered.markdown,'string');assert.equal(rendered.code,undefined);
 assert.equal(typeof (await registry.execute('get_engineering_context',{task:'Inspect index',format:'full'})).markdown,'string');
 const prepared=await registry.execute('prepare_task_context',{taskId:'mcp'});
 assert.equal(prepared.task.taskId,'mcp');assert.equal(prepared.context.code,undefined);assert.equal(prepared.context.markdown,undefined);assert.ok(Array.isArray(prepared.context.unknowns));
 assert.equal((await checkTaskReadiness(root,{taskId:'mcp'})).ready,true);
});

test('edits outside the project are left to the host; project edits and traversal back into it stay gated',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'.graphward/install-manifest.json'),'{}');
 const outside=await realpath(await mkdtemp(path.join(tmpdir(),'gw-outside-')));t.after(()=>rm(outside,{recursive:true,force:true}));
 const decide=async file_path=>{const result=await runHook('pre-tool-use',root,{session_id:'none',cwd:root,tool_name:'Write',tool_input:{file_path}},'claude-code');return result.stdout?JSON.parse(result.stdout).hookSpecificOutput.permissionDecision:'allow';};
 assert.notEqual(await decide(path.join(outside,'notes/memory.md')),'deny');
 assert.equal(await decide(path.join(root,'src/index.ts')),'deny');
 assert.equal(await decide(path.join(root,'src/new-file.ts')),'deny');
 assert.equal(await decide(path.join(outside,'..',path.basename(root),'src/index.ts')),'deny');
});

test('context packs account for every budgeted section: claims counted, seeds visible, badges only for code spans',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'src/use.ts'),'import { searchable } from "./index.js"; export const result = searchable;');await buildGraph(root);
 for(const budget of [1,200,6000]){
  const pack=await getEngineeringContext(root,{task:'Inspect searchable index usage',files:['src/use.ts'],budget});
  const claimTokens=pack.claims.reduce((sum,claim)=>sum+Math.ceil(JSON.stringify(claim).length/4),0);
  assert.ok(pack.tokenAllocation.used<=pack.tokenAllocation.budget||pack.claims.length===0,`budget ${budget}: used ${pack.tokenAllocation.used}`);
  assert.ok(pack.tokenAllocation.knowledge>=claimTokens-pack.claims.length,'claims are charged to the knowledge allocation');
  const ids=new Set(pack.architecture.nodes.map(node=>node.id));assert.ok(pack.architecture.seeds.every(seed=>ids.has(seed)));
  assert.ok((pack.provenanceBadges??[]).every(badge=>badge.badge==='PROV:CURRENT-SOURCE'));
 }
});
