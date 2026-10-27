import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isReadOnlyShellCommand, runHook } from '../dist/hooks/index.js';
import { routeRequest } from '../dist/routing/catalog.js';
import { runGate } from '../dist/gates/index.js';
import { runVerification, coverageFor } from '../dist/verify/index.js';
import { proposeTask, observeUserPrompt, checkTaskReadiness } from '../dist/aidlc/task-contract.js';
import { checkConstructionExit } from '../dist/aidlc/gates.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gw-audit-authority-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  return root;
}
async function write(root, file, value) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
}

test('F01 obvious read probes pass while executable escape paths remain gated', () => {
  for (const command of ['command -v node', "nl -ba src/a.ts | sed -n '1,10p;20,30p'", "node --input-type=module -e 'console.log(1+1)'", "node -p 'JSON.stringify({count:2})'"]) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
  }
  for (const command of ["node -e 'process.exit(0)'", "node -e 'console.log.constructor(\"return process\")().exit()'", "node -e 'require(\"fs\").writeFileSync(\"src/a.ts\",\"x\")'", "sed -n '1p;w output' src/a.ts", 'command rm src/a.ts']) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
  }
});

const reportContract = { kind: 'fix', request: 'Audit and write the findings', intendedUsers: [], behavior: ['Record verified findings'], nonGoals: ['Product edits'], acceptanceCriteria: ['A report describes evidence'], scope: ['.graphward/reports/**'], constraints: [], questions: [] };
test('F01 Codex native wrapped answer confirms the exact revision and scoped reports need no implementation context', async t => {
  const root = await fixture(t);
  await write(root, '.graphward/install-manifest.json', {});
  const proposed = await proposeTask(root, reportContract, { taskId: 'audit', host: 'codex', sessionId: 'native' });
  const prompt = `<send_user_message_question_reply>\n${JSON.stringify([{questionItemId: '["request_user_input_async","call_observed",0]', question: `Confirm this audit scope: ${proposed.challenge}`, answer: proposed.challenge}])}\n</send_user_message_question_reply>`;
  await runHook('user-prompt-submit', root, { session_id: 'other', prompt }, 'codex');
  assert.equal((await checkTaskReadiness(root, { taskId: 'audit', stage: 'requirements' })).ready, false);
  await runHook('user-prompt-submit', root, { session_id: 'native', prompt }, 'codex');
  assert.equal((await checkTaskReadiness(root, { taskId: 'audit', stage: 'requirements' })).ready, true);
  const edit = file => runHook('pre-tool-use', root, {session_id: 'native', tool_name: 'Write', tool_input: {file_path: path.join(root, file)}}, 'codex');
  assert.equal((await edit('.graphward/reports/audit.md')).stdout, undefined);
  assert.equal(JSON.parse((await edit('src/a.ts')).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('F01 report-path symlinks cannot bypass implementation readiness for source targets', async t => {
  const root = await fixture(t);
  const {symlink} = await import('node:fs/promises');
  await write(root,'.graphward/install-manifest.json',{});
  await write(root,'.graphward/reports/normal.md','report');
  await symlink(path.join(root,'src/a.ts'),path.join(root,'.graphward/reports/source-alias.ts'));
  await symlink(path.join(root,'.graphward/reports/normal.md'),path.join(root,'.graphward/reports/report-alias.md'));
  const task = await proposeTask(root,{...reportContract,scope:['src/**','.graphward/reports/**']},{taskId:'mixed',host:'codex',sessionId:'mixed'});
  await observeUserPrompt(root,'codex','mixed',task.challenge);
  const edit = file => runHook('pre-tool-use',root,{session_id:'mixed',tool_name:'Write',tool_input:{file_path:path.join(root,file)}},'codex');
  assert.equal((await edit('.graphward/reports/new.md')).stdout,undefined);
  assert.equal((await edit('.graphward/reports/report-alias.md')).stdout,undefined);
  assert.equal(JSON.parse((await edit('src/a.ts')).stdout).hookSpecificOutput.permissionDecision,'deny');
  assert.equal(JSON.parse((await edit('.graphward/reports/source-alias.ts')).stdout ?? '{}').hookSpecificOutput?.permissionDecision ?? 'allow','deny');
});

test('in-project filenames beginning with two dots still require task authority', async t => {
  const root = await fixture(t);
  await write(root,'.graphward/install-manifest.json',{});
  const result = await runHook('pre-tool-use',root,{session_id:'unconfirmed',tool_name:'Write',tool_input:{file_path:path.join(root,'..notes.ts')}},'codex');
  assert.equal(JSON.parse(result.stdout ?? '{}').hookSpecificOutput?.permissionDecision ?? 'allow','deny');
});

test('F05 check-command changes invalidate receipts and legacy evidence remains advisory', async t => {
  const root = await fixture(t);
  await write(root, 'package.json', {scripts:{test:'node -e "process.exit(0)"'}});
  assert.equal((await runVerification(root)).record.verdict, 'pass');
  assert.equal((await coverageFor(root, ['src/a.ts'])).covered, true);
  await write(root, 'package.json', {scripts:{test:'node -e "process.exit(9)"'}});
  assert.equal((await coverageFor(root, ['src/a.ts'])).covered, false);
  const other = await fixture(t);
  const {hashContent} = await import('../dist/verify/index.js');
  await write(other, '.graphward/.verify/verification-records.json', [{schemaVersion:1,createdAt:new Date().toISOString(),head:'other',projectRoot:'/other',files:{'src/a.ts':hashContent('export const a = 1;\n')},commands:[{command:'declared',exitCode:0}],verdict:'pass'}]);
  assert.equal((await coverageFor(other, ['src/a.ts'])).covered, false);
});

test('F05 custom checks cannot replace failing required checks or establish Stop coverage', async t => {
  const root = await fixture(t);
  await write(root, 'package.json', {scripts:{test:'node -e "process.exit(9)"'}});
  const result = await runVerification(root,{commands:['node -e "0"']});
  assert.equal(result.record.verdict,'pass','the explicitly executed custom check passed');
  assert.equal(result.record.requiredChecksSatisfied,false,'it did not run required npm test');
  assert.equal((await coverageFor(root,['src/a.ts'])).covered,false);
});

test('F04 F07 sensitive control paths and incomplete review artifacts cannot establish a pass', async t => {
  const root = await fixture(t);
  await write(root, 'src/hooks/index.ts', 'export const gated = true;\n');
  assert.equal((await runGate('security-audit', root, {changedFiles:['src/hooks/index.ts'],risk:'high'})).status, 'unavailable');
  await write(root, '.graphward/reports/security-review.json', {});
  assert.equal((await runGate('security-audit', root, {changedFiles:['src/hooks/index.ts'],risk:'high'})).status, 'unavailable');
  await write(root, '.graphward/reports/convention-findings.json', {});
  assert.equal((await runGate('conventions', root, {changedFiles:['src/a.ts']})).status, 'unavailable');
  for (const file of ['src/graph/trust.ts','src/claims/index.ts','src/context/orchestrator.ts','src/config/index.ts','src/routing/catalog.ts','src/evidence/index.ts']) assert.equal((await runGate('security-audit',root,{changedFiles:[file],risk:'critical'})).status,'unavailable',file);
  assert.equal((await runGate('security-audit',root,{changedFiles:['src/future-authority.ts'],risk:'high'})).status,'unavailable');
});

test('F06 pending unbound replay is unavailable rather than a passing API check', async t => {
  const root = await fixture(t);
  await write(root, '.graphward/snapshots/users/manifest.json', {schemaVersion:1,unit:'users',capturedAt:'2000-01-01',sourceFiles:['src/routes/users.ts']});
  await write(root, '.graphward/snapshots/users/replay-report.json', {schemaVersion:1,unit:'users',replayedAt:'2000-01-01',status:'pending',differences:['not checked']});
  assert.equal((await runGate('api-snapshot', root, {changedFiles:['src/routes/users.ts']})).status, 'unavailable');
});

test('F02 explicit unavailable outcome is opt-in, session/source bound and never waives configured failures', async t => {
  const root = await fixture(t);
  await write(root, '.graphward/gw.config.json', {providers:{policy:'native'},hooks:{unavailableValidationPolicy:'allow-explicit'}});
  const event = {session_id:'unavailable',tool_name:'Write',tool_input:{file_path:path.join(root,'src/a.ts')}};
  await runHook('post-tool-use', root, event, 'codex');
  assert.ok((await runHook('stop', root, {session_id:'unavailable'}, 'codex')).stdout);
  await runHook('user-prompt-submit', root, {session_id:'unavailable',prompt:'Validation is unavailable; no check commands are configured.'}, 'codex');
  assert.equal((await runHook('stop', root, {session_id:'unavailable'}, 'codex')).stdout, undefined);
  await write(root, 'src/a.ts', 'export const a = 2;\n');
  assert.ok((await runHook('stop', root, {session_id:'unavailable'}, 'codex')).stdout);
  await write(root, 'package.json', {scripts:{test:'node -e "process.exit(9)"'}});
  await runHook('user-prompt-submit', root, {session_id:'unavailable',prompt:'Validation is unavailable; no check commands are configured.'}, 'codex');
  assert.ok((await runHook('stop', root, {session_id:'unavailable'}, 'codex')).stdout);
});

test('F03 construction completion cannot pass without confirmation, prepared context, mappings and executed checks', async t => {
  const root = await fixture(t);
  await proposeTask(root, reportContract, {taskId:'unconfirmed',host:'codex',sessionId:'construction'});
  const result = await checkConstructionExit(root, 'unconfirmed');
  assert.equal(result.status, 'blocked');
  assert.ok(result.missingPrerequisites.some(item => /confirmation|confirmed|scope/i.test(item)));
  assert.ok(result.missingPrerequisites.some(item => /verification|executed/i.test(item)));
  assert.ok(result.missingPrerequisites.some(item => /acceptance|mapping/i.test(item)));
});

test('F43 explicit repairs route to a workflow that can modify the product', () => {
  for (const prompt of ['fix architecture map generation', 'fix impact analysis', 'fix the review engineering change parser']) assert.equal(routeRequest(prompt), 'graphward', prompt);
  assert.equal(routeRequest('map the architecture'), 'map-architecture');
  assert.equal(routeRequest('analyze impact without changes'), 'analyze-impact');
});

test('F34 learned guidance requires contained current source backing and stale promoted evidence is quarantined', async t => {
  const root = await fixture(t);
  const {proposeLearnedPattern, promoteLearnedPattern, queryProjectMemory} = await import('../dist/learning/index.js');
  const pattern = file => ({type:'convention',title:'Evidence-backed rule',description:'Observed local example',rule:'Keep the observed contract',targetFiles:[file]});
  const missing = await proposeLearnedPattern(root, pattern('src/missing.ts'));
  await assert.rejects(promoteLearnedPattern(root, missing.id, {reviewer:'reviewer',rationale:'checked',promote:true}), /evidence|source|missing/i);
  const valid = await proposeLearnedPattern(root, pattern('src/a.ts'));
  await promoteLearnedPattern(root, valid.id, {reviewer:'reviewer',rationale:'checked current source',promote:true});
  assert.equal((await queryProjectMemory(root)).conventions.length, 1);
  await write(root, 'src/a.ts', 'export const a = 99;\n');
  const changed = await queryProjectMemory(root);
  assert.equal(changed.conventions.length, 0);
  assert.equal(changed.quarantinedGuidance.length, 1);
});

test('F04 F07 completed current reviews pass; pending, unrelated, stale and unvalidated waivers do not', async t => {
  const root = await fixture(t);
  await write(root, 'src/hooks/index.ts', 'export const gated = true;\n');
  const {createReviewBinding} = await import('../dist/gates/review-evidence.js');
  const review = {schemaVersion:1,status:'complete',reviewer:'independent fixture reviewer',reviewedAt:new Date().toISOString(),binding:await createReviewBinding(root,['src/hooks/index.ts','src/a.ts']),findings:[]};
  await write(root, '.graphward/reports/security-review.json', review);
  await write(root, '.graphward/reports/convention-findings.json', review);
  assert.equal((await runGate('security-audit',root,{changedFiles:['src/hooks/index.ts']})).status,'pass');
  assert.equal((await runGate('conventions',root,{changedFiles:['src/a.ts']})).status,'pass');
  const convention = {severity:'critical',message:'Open critical finding',confidence:1,adherence:1,waiver:{owner:' ',rationale:' ',expiresAt:new Date(Date.now()+60_000).toISOString()}};
  await write(root,'.graphward/reports/convention-findings.json',{...review,findings:[convention]});
  assert.equal((await runGate('conventions',root,{changedFiles:['src/a.ts']})).status,'fail','blank waiver ownership cannot suppress a finding');
  await write(root,'.graphward/reports/convention-findings.json',{...review,findings:[{severity:'minor',message:'Advisory naming finding',confidence:1,adherence:1}]});
  assert.equal((await runGate('conventions',root,{changedFiles:['src/a.ts']})).status,'warn','advisory evidence remains visible');
  await write(root, '.graphward/reports/security-review.json', {...review,status:'pending'});
  assert.equal((await runGate('security-audit',root,{changedFiles:['src/hooks/index.ts']})).status,'unavailable');
  await write(root, '.graphward/reports/security-review.json', {...review,findings:[{severity:'high',message:'Still open',waived:true}]});
  assert.equal((await runGate('security-audit',root,{changedFiles:['src/hooks/index.ts']})).status,'fail');
  await write(root, '.graphward/reports/security-review.json', review);
  await write(root, 'src/hooks/index.ts', 'export const gated = false;\n');
  assert.equal((await runGate('security-audit',root,{changedFiles:['src/hooks/index.ts']})).status,'unavailable');
});

test('rollback plan gate diagnoses invalid schema rather than throwing or claiming execution', async t => {
  const root = await fixture(t);
  for (const value of [null,[],{schemaVersion:99,codeRevert:'restore',stateCompensation:'none',disablePath:'stop',externalEffects:'none',irreversibleSteps:'none',verification:'checks'}]) {
    await write(root,'.graphward/aidlc/operations/rollback-readiness.json',JSON.stringify(value));
    assert.equal((await runGate('rollback-readiness',root,{risk:'medium'})).status,'unavailable');
  }
});

test('F06 API replay binds supplied response, request baseline and current source generation', async t => {
  const root = await fixture(t);
  await write(root,'src/routes/users.ts','export const endpoint = "users";\n');
  const {captureApiSnapshot,replayApiSnapshot} = await import('../dist/gates/api-snapshot.js');
  const exchange = {request:{method:'GET',path:'/users'},response:{status:200,body:{users:[]}}};
  await captureApiSnapshot(root,'users',exchange,{sourceFiles:['src/routes/users.ts']});
  await replayApiSnapshot(root,'users',exchange);
  assert.equal((await runGate('api-snapshot',root,{changedFiles:['src/routes/users.ts']})).status,'pass');
  await replayApiSnapshot(root,'users',{...exchange,response:{status:403,body:{error:'forbidden'}}});
  assert.equal((await runGate('api-snapshot',root,{changedFiles:['src/routes/users.ts']})).status,'fail');
  await replayApiSnapshot(root,'users',exchange);
  await write(root,'src/routes/users.ts','export const endpoint = "changed";\n');
  assert.equal((await runGate('api-snapshot',root,{changedFiles:['src/routes/users.ts']})).status,'unavailable');
});

test('F06 snapshot units and output ancestors remain contained', async t => {
  const root = await fixture(t);
  const {captureApiSnapshot} = await import('../dist/gates/api-snapshot.js');
  const {symlink} = await import('node:fs/promises');
  const exchange = {request:{method:'GET',path:'/users'},response:{status:200}};
  await assert.rejects(captureApiSnapshot(root,'..',exchange,{sourceFiles:['src/a.ts']}),/unit|path/i);
  const outside = await fixture(t);
  await mkdir(path.join(root,'.graphward'),{recursive:true});
  await symlink(outside,path.join(root,'.graphward/snapshots'),'dir');
  await assert.rejects(captureApiSnapshot(root,'users',exchange,{sourceFiles:['src/a.ts']}),/escapes|outside|contained/i);
});

test('review bindings accept aliased roots and contained deletions, then expire on reappearance', async t => {
  const root = await fixture(t);
  const {symlink} = await import('node:fs/promises');
  const alias = root + '-alias';
  await symlink(root, alias, 'dir');
  t.after(()=>rm(alias,{force:true}));
  const {createReviewBinding,validateReviewBinding} = await import('../dist/gates/review-evidence.js');
  const binding = await createReviewBinding(alias,['src/a.ts','src/deleted.ts']);
  assert.equal(binding.files['src/deleted.ts'],'missing');
  assert.equal(await validateReviewBinding(alias,binding,['src/a.ts','src/deleted.ts']),undefined);
  await write(root,'src/deleted.ts','reappeared');
  assert.match(await validateReviewBinding(alias,binding,['src/deleted.ts']),/changed/);
});

test('F03 a new lifecycle unit resets completed status and a fully checked confirmed candidate can finish', async t => {
  const root = await fixture(t);
  const {createConsolidatedRegistry} = await import('../dist/mcp/consolidated.js');
  await write(root,'.graphward/aidlc/aidlc-state.json',{schemaVersion:1,updatedAt:new Date().toISOString(),position:{phase:'construction',stage:'previous',completionStatus:'complete'},breadcrumb:'previous'});
  const registry = await createConsolidatedRegistry(root);
  const update = await registry.execute('update_aidlc_state',{stage:'current unit',activeUnit:'audit'});
  assert.equal(update.state.position.completionStatus,'in-progress');
  await write(root,'.graphward/gw.config.json',{providers:{policy:'native'}});
  await write(root,'package.json',{scripts:{test:'node --test test/acceptance.test.mjs'}});
  await write(root,'test/acceptance.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('source contract',()=>assert.match(readFileSync('src/a.ts','utf8'),/a = 1/));\n");
  const task = await proposeTask(root,{...reportContract,scope:['src','test','package.json']},{taskId:'complete',host:'codex',sessionId:'complete'});
  await observeUserPrompt(root,'codex','complete',task.challenge);
  const {prepareTaskContext} = await import('../dist/context/preparation.js');
  const {bindTaskContext,recordTaskChangeMapping} = await import('../dist/aidlc/task-contract.js');
  await prepareTaskContext(root);
  await bindTaskContext(root,'complete');
  await recordTaskChangeMapping(root,'complete',[{criterion:reportContract.acceptanceCriteria[0],files:['src/a.ts'],tests:['npm test'],rationale:'The executed fixture checks the source contract.'}]);
  const {nonGitProjectFiles} = await import('../dist/verify/index.js');
  const {createReviewBinding} = await import('../dist/gates/review-evidence.js');
  const review = {schemaVersion:1,status:'complete',reviewer:'fixture reviewer',reviewedAt:new Date().toISOString(),binding:await createReviewBinding(root,await nonGitProjectFiles(root)),findings:[]};
  await write(root,'.graphward/reports/security-review.json',review);
  await write(root,'.graphward/reports/convention-findings.json',review);
  await write(root,'.graphward/aidlc/operations/rollback-readiness.json',{schemaVersion:1,codeRevert:'restore captured fixture',stateCompensation:'none',disablePath:'stop fixture',externalEffects:'none',irreversibleSteps:'none',verification:'npm test'});
  assert.equal((await runVerification(root)).record.verdict,'pass');
  const result = await checkConstructionExit(root,'complete');
  assert.equal(result.status,'pass',JSON.stringify(result));
  await write(root,'src/a.ts','export const a = 2;\n');
  assert.equal((await checkConstructionExit(root,'complete')).status,'blocked');
});
