import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runEndToEndBenchmark} from '../scripts/evaluate-agent-runs.mjs';
const canonical=value=>JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):Array.isArray(value)?value.map(x=>JSON.parse(canonical(x))):value);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const measured=(configuration,repository='repo-a')=>({evidence:'measured',heldOut:true,configuration,repository,taskId:'task',sourceRevision:'source',requestHash:'request',candidateHash:'candidate',model:'model',modelVersion:'version',checks:[{command:configuration==='baseline'?'exit 1':'exit 0',exitCode:configuration==='baseline'?1:0,timedOut:false}],regressions:0,requiredChangesMissed:0,unnecessaryChanges:0,clarificationErrors:0,relevantContextMissed:0,latencyMs:10,cost:0});
async function validFixture(){
 const root=await mkdtemp(path.join(tmpdir(),'gw-release-evidence-'));await mkdir(path.join(root,'checks'));
 const tasks=Array.from({length:20},(_,i)=>({taskId:`task-${i}`,repository:`repo-${i%3}`,sourceRevision:`source-${i}`,requestHash:hash(`request-${i}`),oracleHash:hash(`oracle-${i}`),split:'held-out',checks:[{id:'acceptance',command:'node check.cjs',timeoutMs:1000}]}));
 const protocol={schemaVersion:1,id:'frozen-synthetic-consistency-fixture',preregisteredAt:'2026-01-01T00:00:00.000Z',minimumPairs:20,minimumRepositories:3,tasks};
 const protocolHash=hash(protocol),records=[];
 for(const task of tasks)for(const configuration of ['baseline','graphward']){
  const startedAt='2026-01-02T00:00:00.000Z',completedAt='2026-01-02T00:00:00.010Z';
  const identity={taskId:task.taskId,repository:task.repository,sourceRevision:task.sourceRevision,requestHash:task.requestHash,oracleHash:task.oracleHash,configuration,model:'fixed-model',modelVersion:'fixed-version',candidateHash:hash('candidate')};
  const artifact={schemaVersion:1,evidenceType:'executed-check',...identity,protocolHash,checkId:'acceptance',command:'node check.cjs',timeoutMs:1000,exitCode:configuration==='baseline'?1:0,timedOut:false,startedAt,completedAt};
  const bytes=JSON.stringify(artifact),relative=`checks/${task.taskId}-${configuration}.json`;await writeFile(path.join(root,relative),bytes);
  records.push({evidence:'measured',heldOut:true,...identity,protocolHash,startedAt,completedAt,checks:[{id:'acceptance',command:'node check.cjs',timeoutMs:1000,exitCode:artifact.exitCode,timedOut:false,evidence:{path:relative,sha256:hash(bytes)}}],regressions:0,requiredChangesMissed:configuration==='baseline'?1:0,unnecessaryChanges:0,clarificationErrors:0,relevantContextMissed:0,latencyMs:10,cost:0});
 }
 return{root,input:{schemaVersion:2,protocol,protocolHash,records}};
}
test('audit F35: two incomparable unbound supplied pairs cannot qualify a release',async()=>{
 const rows=['repo-a','repo-b'].flatMap(r=>[measured('baseline',r),measured('graphward',r)]);
 assert.equal((await runEndToEndBenchmark(rows)).passed,false);
});
test('audit F35: complete frozen evidence fixture validates consistency and rejects changed oracle/checks',async()=>{
 const {root,input}=await validFixture();
 const result=await runEndToEndBenchmark(input,{evidenceRoot:root});assert.equal(result.passed,true,JSON.stringify(result.failures));assert.equal(result.netImprovementPct,100);assert.equal(result.measurementProvenance,'supplied-artifacts');
 const unequal=structuredClone(input);unequal.records[1].checks[0].command='exit 0';assert.equal((await runEndToEndBenchmark(unequal,{evidenceRoot:root})).passed,false);
 const wrongOracle=structuredClone(input);wrongOracle.records[1].oracleHash=hash('other oracle');assert.equal((await runEndToEndBenchmark(wrongOracle,{evidenceRoot:root})).passed,false);
});
test('audit F35: tampered, outside, missing and stale evidence fail closed',async()=>{
 const {root,input}=await validFixture();const artifact=path.join(root,input.records[0].checks[0].evidence.path);const original=await readFile(artifact,'utf8');await writeFile(artifact,original+' ');assert.equal((await runEndToEndBenchmark(input,{evidenceRoot:root})).passed,false);await writeFile(artifact,original);
 const outside=structuredClone(input);outside.records[0].checks[0].evidence.path='../outside.json';assert.equal((await runEndToEndBenchmark(outside,{evidenceRoot:root})).passed,false);
 assert.equal((await runEndToEndBenchmark(input)).passed,false);
 const stale=JSON.parse(original);stale.sourceRevision='unrelated';const bytes=JSON.stringify(stale);await writeFile(artifact,bytes);const changed=structuredClone(input);changed.records[0].checks[0].evidence.sha256=hash(bytes);assert.equal((await runEndToEndBenchmark(changed,{evidenceRoot:root})).passed,false);
});
test('audit F35: frozen sample coverage and integer error counts are required',async()=>{
 const {root,input}=await validFixture();const missing=structuredClone(input);missing.records.pop();assert.equal((await runEndToEndBenchmark(missing,{evidenceRoot:root})).passed,false);
 const fractional=structuredClone(input);fractional.records[0].regressions=0.5;assert.equal((await runEndToEndBenchmark(fractional,{evidenceRoot:root})).passed,false);
 const duplicate=structuredClone(input);duplicate.records.push({...duplicate.records[0],model:'different'});assert.equal((await runEndToEndBenchmark(duplicate,{evidenceRoot:root})).passed,false);
 const weak=structuredClone(input);weak.protocol.minimumPairs=2;weak.protocolHash=hash(weak.protocol);assert.equal((await runEndToEndBenchmark(weak,{evidenceRoot:root})).passed,false);
 const late=structuredClone(input);late.protocol.preregisteredAt='2026-01-03T00:00:00Z';late.protocolHash=hash(late.protocol);assert.equal((await runEndToEndBenchmark(late,{evidenceRoot:root})).passed,false);
});
