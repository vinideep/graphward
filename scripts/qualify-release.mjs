import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {runEndToEndBenchmark} from './evaluate-agent-runs.mjs';
const args=process.argv.slice(2);const option=name=>args[args.indexOf(name)+1];
const candidate=option('--candidate');const reports=option('--reports');const measurements=option('--measurements');
if(!candidate||!reports||!measurements)throw Error('Use --candidate <exact-tarball> --reports <native-report-directory> --measurements <measured-runs.json>.');
const candidateHash=createHash('sha256').update(await readFile(candidate)).digest('hex');const failures=[];
for(const host of ['codex','claude-code','antigravity-cli','antigravity']) {
 try {
  const evidence=JSON.parse(await readFile(path.join(reports,`${host}.json`),'utf8'));
  if(evidence.host!==host||evidence.candidateHash!==candidateHash||evidence.evidence!=='native-host'||evidence.passed!==true||!evidence.providerContextContribution?.some(context=>context.cceAccepted>0&&context.graphifyNodes>0)||!['generated','discovered','enabled','connected','invoked','enforcementTested'].every(stage=>evidence[stage]===true)||!Array.isArray(evidence.scenarios)||!['natural-feature','entry-feature','mutation-guard'].every(id=>evidence.scenarios.some(scenario=>scenario.id===id&&scenario.exitCode===0&&!scenario.timedOut&&!scenario.markerCreated))) failures.push(`${host}: exact candidate native qualification is incomplete.`);
 }catch{failures.push(`${host}: native qualification evidence unavailable.`);}
}
let evaluation;
try {const envelope=JSON.parse(await readFile(measurements,'utf8'));const records=envelope?.records;if(envelope?.schemaVersion!==2||!Array.isArray(records)||records.some(record=>record.candidateHash!==candidateHash))failures.push('Measured runs do not identify this candidate or its frozen protocol.');evaluation=await runEndToEndBenchmark(envelope,{evidenceRoot:path.dirname(path.resolve(measurements))});if(!evaluation.passed)failures.push(...evaluation.failures);}
catch{failures.push('Measured held-out evaluation unavailable.');}
console.log(JSON.stringify({schemaVersion:1,candidateHash,passed:failures.length===0,failures,evaluation},null,2));if(failures.length)process.exitCode=1;
