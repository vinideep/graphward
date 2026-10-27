import {readFile,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const COUNTS=['regressions','requiredChangesMissed','unnecessaryChanges','clarificationErrors','relevantContextMissed'];
const METRICS=[...COUNTS,'latencyMs','cost'];
const text=v=>typeof v==='string'&&v.trim().length>0;
const hashValue=v=>typeof v==='string'&&/^[a-f0-9]{64}$/i.test(v);
const time=v=>typeof v==='string'?Date.parse(v):NaN;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function canonical(v){
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(object(v))return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 return JSON.stringify(v)??'null';
}
const hash=v=>createHash('sha256').update(v).digest('hex');
const within=(root,file)=>{const rel=path.relative(root,file);return rel!==''&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);};
const taskKey=t=>JSON.stringify([t.repository,t.taskId]);
const empty=(status,failures)=>({status,passed:false,measurementProvenance:'supplied-artifacts',qualificationScope:'supplied-record-consistency',improvementClaim:false,capabilities:[],ablations:[],netImprovementPct:null,regressionEscapeRate:null,failures});
async function verifyArtifact(root,evidence,expected,run){
 if(!object(evidence)||!text(evidence.path)||!hashValue(evidence.sha256)||path.isAbsolute(evidence.path)||/^[a-z]:/i.test(evidence.path)||evidence.path.split(/[\\/]/).includes('..')||!evidence.path.endsWith('.json'))return false;
 const lexical=path.resolve(root,evidence.path);if(!within(root,lexical))return false;
 try{
  const resolved=await realpath(lexical);if(!within(root,resolved))return false;
  const info=await stat(resolved);if(!info.isFile()||info.size>2*1024*1024)return false;
  const bytes=await readFile(resolved);if(hash(bytes)!==evidence.sha256.toLowerCase())return false;
  const artifact=JSON.parse(bytes.toString('utf8'));
  if(!object(artifact)||artifact.schemaVersion!==1||artifact.evidenceType!=='executed-check'||!Object.entries(expected).every(([k,v])=>artifact[k]===v))return false;
  return Number.isFinite(time(artifact.startedAt))&&Number.isFinite(time(artifact.completedAt))&&time(artifact.startedAt)>=time(run.startedAt)&&time(artifact.completedAt)>=time(artifact.startedAt)&&time(artifact.completedAt)<=time(run.completedAt)&&!artifact.error;
 }catch{return false;}
}
/** Validate frozen paired supplied evidence; this does not attest to who collected it. */
export async function runEndToEndBenchmark(input=[],options={}){
 if(!object(input)||input.schemaVersion!==2||!object(input.protocol)||!Array.isArray(input.records))return empty('unavailable',['Qualification requires a schema2 frozen protocol and contained executed-check artifacts; legacy arrays are advisory only.']);
 const {protocol,records}=input,failures=[];
 const fail=m=>{if(!failures.includes(m))failures.push(m);};
 if(protocol.schemaVersion!==1||!text(protocol.id)||!Number.isFinite(time(protocol.preregisteredAt))||!Number.isInteger(protocol.minimumPairs)||protocol.minimumPairs<20||!Number.isInteger(protocol.minimumRepositories)||protocol.minimumRepositories<3||!Array.isArray(protocol.tasks)||protocol.tasks.length>10000||!hashValue(input.protocolHash)||hash(canonical(protocol))!==input.protocolHash)return empty('failed',['Frozen protocol identity, preregistration or sample floor is invalid (at least 20 task pairs across 3 repositories). These floors do not establish statistical power.']);
 let evidenceRoot;
 try{if(!text(options.evidenceRoot))throw Error('missing');evidenceRoot=await realpath(path.resolve(options.evidenceRoot));if(!(await stat(evidenceRoot)).isDirectory())throw Error('not directory');}
 catch{return empty('unavailable',['An explicitly selected local evidence directory is required.']);}
 const tasks=new Map();
 for(const task of protocol.tasks){
  if(!object(task)||!['taskId','repository','sourceRevision'].every(k=>text(task[k]))||!hashValue(task.requestHash)||!hashValue(task.oracleHash)||task.split!=='held-out'||!Array.isArray(task.checks)||!task.checks.length||!task.checks.every(c=>object(c)&&text(c.id)&&text(c.command)&&Number.isInteger(c.timeoutMs)&&c.timeoutMs>0)||new Set(task.checks.map(c=>c.id)).size!==task.checks.length){fail('Frozen task lacks a unique held-out identity, oracle or executable check specification.');continue;}
  const key=taskKey(task);if(tasks.has(key)){fail('Frozen task identities cannot be duplicated across revisions, models or requests.');continue;}tasks.set(key,task);
 }
 if(tasks.size<protocol.minimumPairs||new Set([...tasks.values()].map(t=>t.repository)).size<protocol.minimumRepositories)fail('Frozen held-out task set does not meet its preregistered task/repository floor.');
 if(records.length>20000)return empty('failed',['Measured record count exceeds the supported bounded input size.']);
 const groups=new Map();
 for(const run of records){
  if(!object(run)||run.evidence!=='measured'||run.heldOut!==true||!['baseline','graphward'].includes(run.configuration)||!['taskId','repository','sourceRevision','model','modelVersion'].every(k=>text(run[k]))||!hashValue(run.requestHash)||!hashValue(run.oracleHash)||!hashValue(run.candidateHash)||run.protocolHash!==input.protocolHash||!Number.isFinite(time(run.startedAt))||time(run.startedAt)<time(protocol.preregisteredAt)||!Number.isFinite(time(run.completedAt))||time(run.completedAt)<time(run.startedAt)||!COUNTS.every(k=>Number.isSafeInteger(run[k])&&run[k]>=0)||!['latencyMs','cost'].every(k=>Number.isFinite(run[k])&&run[k]>=0)){fail('Run lacks fixed measured identities, preregistered timing, integer error counts or finite cost/latency.');continue;}
  const key=taskKey(run),task=tasks.get(key);
  if(!task||!['sourceRevision','requestHash','oracleHash'].every(k=>run[k]===task[k])){fail('Run is outside its frozen task/source/request/oracle identity.');continue;}
  if(!Array.isArray(run.checks)||run.checks.length!==task.checks.length){fail('Run does not execute its complete frozen check specification.');continue;}
  let valid=true;
  for(let index=0;index<task.checks.length;index++){
   const spec=task.checks[index],check=run.checks[index];
   if(!object(check)||check.id!==spec.id||check.command!==spec.command||check.timeoutMs!==spec.timeoutMs||!Number.isInteger(check.exitCode)||typeof check.timedOut!=='boolean'||check.error){valid=false;break;}
   const expected=Object.fromEntries(['taskId','repository','sourceRevision','requestHash','oracleHash','configuration','model','modelVersion','candidateHash','protocolHash'].map(k=>[k,run[k]]));
   Object.assign(expected,{checkId:spec.id,command:spec.command,timeoutMs:spec.timeoutMs,exitCode:check.exitCode,timedOut:check.timedOut});
   if(!await verifyArtifact(evidenceRoot,check.evidence,expected,run)){valid=false;break;}
  }
  if(!valid){fail('Executed check evidence is missing, stale, tampered, uncontained or incomparable to the frozen oracle/specification.');continue;}
  const group=groups.get(key)??{};
  if(group[run.configuration]){fail('Duplicate task/arm observation cannot inflate the held-out sample.');continue;}
  group[run.configuration]=run;groups.set(key,group);
 }
 const paired=[];
 for(const key of tasks.keys()){
  const group=groups.get(key);
  if(!group?.baseline||!group.graphward){fail('Every frozen task requires both baseline and GraphWard evidence; incomplete subsets cannot qualify.');continue;}
  if(!['model','modelVersion','candidateHash'].every(k=>group.baseline[k]===group.graphward[k])){fail('Paired arms differ in model/version or evaluated package candidate.');continue;}
  paired.push(group);
 }
 const resolved=run=>run.checks.every(c=>c.exitCode===0&&!c.timedOut)&&COUNTS.every(k=>run[k]===0);
 const ablations=['baseline','graphward'].map(configuration=>({configuration,tasksAttempted:paired.length,tasksResolved:paired.filter(p=>resolved(p[configuration])).length,regressionsIntroduced:paired.reduce((sum,p)=>sum+p[configuration].regressions,0),metrics:Object.fromEntries(METRICS.map(metric=>[metric,paired.length?paired.reduce((sum,p)=>sum+p[configuration][metric],0)/paired.length:null]))}));
 const improvement=paired.length?100*(ablations[1].tasksResolved-ablations[0].tasksResolved)/paired.length:null;
 const regressionRate=paired.length?100*paired.filter(p=>p.graphward.regressions>0).length/paired.length:null;
 if(improvement===null||regressionRate===null)fail('No valid paired runs.');
 if(improvement!==null&&improvement<20)fail('Reported improvement is below the 20 percentage-point release threshold.');
 if(regressionRate!==null&&regressionRate>2)fail('Reported regression escape rate exceeds 2 percent.');
 return{status:failures.length?'failed':'measured',passed:!failures.length,measurementProvenance:'supplied-artifacts',qualificationScope:'supplied-record-consistency',improvementClaim:false,capabilities:[],ablations,netImprovementPct:improvement,regressionEscapeRate:regressionRate,failures};
}
export async function main(){
 const index=process.argv.indexOf('--results');let result;
 try{const file=index>=0?process.argv[index+1]:undefined;result=await runEndToEndBenchmark(file?JSON.parse(await readFile(file,'utf8')):[],file?{evidenceRoot:path.dirname(path.resolve(file))}:{});}
 catch{result=empty('unavailable',['Measured evaluation input could not be read or parsed.']);}
 console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
