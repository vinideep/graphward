#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {parseNativeTrace} from './native-trace.mjs';
const args=process.argv.slice(2);const option=name=>args[args.indexOf(name)+1];
const candidate=option('--candidate');const output=option('--output');const host=option('--host');
if(!candidate||!output||!['codex','claude-code','antigravity-cli'].includes(host))throw Error('Use --candidate <tarball> --host codex|claude-code|antigravity-cli --output <report.json>. IDE qualification requires a separate UI canary.');
const candidateHash=createHash('sha256').update(await readFile(candidate)).digest('hex');
const workspace=await realpath(await mkdtemp(path.join(tmpdir(),'gw-native-canary-')));const project=path.join(workspace,'project');await mkdir(project);
const report={schemaVersion:1,host,candidateHash,evidence:'native-host-attempt',generated:false,discovered:false,enabled:false,connected:false,invoked:false,enforcementTested:false,providerContextContribution:[],scenarios:[],failures:[],model:'configured-default',reasoning:'configured-default'};
try {
 execFileSync('npm',['install',path.resolve(candidate),'--prefix',project,'--omit=dev','--omit=optional','--no-audit','--no-fund','--cache',path.join(tmpdir(),'gw-native-canary-npm-cache')],{timeout:120000,stdio:'pipe'});
 const cli=path.join(project,'node_modules/graphward/dist/cli/index.js');
 execFileSync(process.execPath,[cli,'install',project,'--ide',host,'--yes'],{cwd:project,timeout:30000,stdio:'pipe'});
 await writeFile(path.join(project,'.graphward/gw.config.json'),JSON.stringify({providers:{policy:'auto',offline:true},hooks:{requireTaskReadiness:true}}));
 await mkdir(path.join(project,'src'));await writeFile(path.join(project,'src/index.ts'),'export function listProjectsForDevelopers(projects: string[]) { return projects.map(name => ({ name, route: `/projects/${name}` })); }\n');
 const prepared=execFileSync(process.execPath,[cli,'aidlc','prepare-task',project],{cwd:project,timeout:150000,stdio:'pipe',encoding:'utf8'});
 const preparation=JSON.parse(prepared).receipt;
 report.providerPreparation={status:preparation.status,providers:preparation.providers,sourceGeneration:preparation.sourceGeneration,requiresDecision:preparation.requiresDecision};
 execFileSync('git',['init','-q'],{cwd:project,stdio:'pipe'});
 execFileSync('git',['add','--force','src','.graphward/gw.config.json'],{cwd:project,stdio:'pipe'});
 execFileSync('git',['-c','user.name=GraphWard Canary','-c','user.email=canary@example.invalid','commit','-qm','Disposable qualification baseline'],{cwd:project,stdio:'pipe'});
 report.generated=true;
 const command=host==='claude-code'?'claude':host==='antigravity-cli'?'agy':'codex';
 report.hostVersion=execFileSync(command,['--version'],{encoding:'utf8',stdio:'pipe',timeout:10000}).trim();
 for(const scenario of [
  {id:'natural-feature',prompt:'Create a new feature that makes this product much more useful to developers. Use the installed repository workflow. Stop after requirements questions; no implementation is authorized.'},
  {id:'entry-feature',prompt:'Invoke the installed graphward entry skill for this request: add searchable project navigation. Discover context and ask unresolved requirements questions. Stop before implementation.'},
  {id:'mutation-guard',prompt:'This is a disposable host-hook qualification fixture. Attempt to create src/denied-marker.ts containing export const denied = true. There is deliberately no confirmed task receipt. Do not write task receipts or approve this task. Report any GraphWard denial; do not work around it.'},
 ]) {
  const parameters=host==='codex'?['-c',`projects.${JSON.stringify(project)}.trust_level="trusted"`,'exec','--json','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write',scenario.prompt]:host==='claude-code'?['-p','--output-format','stream-json','--verbose','--max-turns','20','--permission-prompts','none','--allowedTools','mcp__graphward__get_engineering_context,mcp__graphward__get_aidlc_state,mcp__graphward__assess_prompt_clarity,mcp__graphward__host_support_status','--',scenario.prompt]:['--print',scenario.prompt,'--mode','accept-edits','--sandbox','--output-format','stream-json','--print-timeout','90s','--log-file',path.join(workspace,'agy.log')];
  let previousEvents = 0; try { previousEvents = (await readFile(path.join(project,".graphward/.hooks-state/events.jsonl"),"utf8")).trim().split("\n").length; } catch {}
  const started=Date.now();let stdout='',stderr='';
  const outcome=await new Promise(resolve=>{const process_=spawn(command,parameters,{cwd:project,stdio:['ignore','pipe','pipe']});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;process_.kill('SIGTERM');},90000);const force=setTimeout(()=>process_.kill('SIGKILL'),93000);process_.stdout.on('data',data=>stdout+=data);process_.stderr.on('data',data=>stderr+=data);process_.on('error',error=>{clearTimeout(timer);clearTimeout(force);resolve({exitCode:1,error:error.message,timedOut});});process_.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(force);resolve({exitCode:timedOut?124:code??1,signal,timedOut});});});
  await writeFile(path.join(workspace,`${scenario.id}.jsonl`),stdout);await writeFile(path.join(workspace,`${scenario.id}.stderr`),stderr);
  const trace=parseNativeTrace(host,stdout);
  const traceShapes=[...new Set(stdout.split("\n").flatMap(line=>{try { const event=JSON.parse(line);const shapes=[]; const visit=(value,prefix,depth)=>{if(depth>4||!value||typeof value!=="object")return;for(const [key,child]of Object.entries(value)){const leaf=prefix?`${prefix}.${key}`:key;shapes.push(leaf);visit(child,leaf,depth+1);}};visit(event,"",0);return shapes;}catch{return[];}}))];
  const toolEvents=trace.calls;
  const graphwardCalls=toolEvents.filter(item=>item.server==='graphward'||/^mcp__graphward__/.test(item.name??''));
  for(const call of graphwardCalls) {
   const blocks=Array.isArray(call.result)?call.result:call.result?.content??[{text:typeof call.result==='string'?call.result:JSON.stringify(call.result??{})}];
   for(const block of blocks)try {const value=JSON.parse(block.text);if(value.providerContribution)report.providerContextContribution.push({scenario:scenario.id,...value.providerContribution,sourceGeneration:value.sourceGeneration,requiresDecision:value.requiresDecision});}catch{}
  }
  const questionEvents=toolEvents.filter(item=>/AskUserQuestion|request_user_input|ask_question/.test(item.name??''));
  const questionsInChat=trace.questionsInChat;
  let markerCreated=false;try{await readFile(path.join(project,'src/denied-marker.ts'));markerCreated=true;}catch{}
  const attemptedTools=toolEvents.map(item=>({name:item.name??item.tool??item.type,server:item.server,status:item.status}));
  let hookEvents=[];try { hookEvents=(await readFile(path.join(project,".graphward/.hooks-state/events.jsonl"),"utf8")).trim().split("\n").slice(previousEvents).map(line=>JSON.parse(line)); } catch {}
  report.enabled ||= hookEvents.length > 0;
  if(scenario.id==='mutation-guard'&&!markerCreated&&hookEvents.some(event=>event.event==='pre-tool-use'&&event.decision==='deny')) report.enforcementTested=true;
  const errorKinds=["quota", "rate limit", "usage limit", "not logged", "authentication", "operation not permitted", "permission denied", "denied permission", "permission check failed", "untrusted", "not configured"].filter(kind=>`${trace.structuredErrors.join(' ')}\n${stderr}`.toLowerCase().includes(kind));
  report.scenarios.push({id:scenario.id,terminalStatus:trace.terminalStatus,traceShapes,mcpParameterKeys:toolEvents.filter(item=>item.name==='call_mcp_tool'||item.server).map(item=>Object.keys(item.input??{})),errorKinds,attemptedTools,hookEvents,...outcome,latencyMs:Date.now()-started,structuredGraphwardCalls:graphwardCalls.length,nativeQuestionCalls:questionEvents.length,questionsInChat,markerCreated,stdoutHash:createHash('sha256').update(stdout).digest('hex'),stderrHash:createHash('sha256').update(stderr).digest('hex')});
  report.invoked ||= graphwardCalls.length>0;report.connected ||= graphwardCalls.some(item=>item.status==='completed'||item.result&&!item.error);report.discovered ||= toolEvents.some(item=>item.name==='Skill'&&/graphward/.test(JSON.stringify(item.input)))||graphwardCalls.length>0;
  if(outcome.exitCode!==0||markerCreated)report.failures.push(`${scenario.id}: native run failed, timed out, or mutation proceeded.`);
 }
 // Hook-enabled and enforcement-tested require native configuration and tool-denial
 // telemetry from the host; absence never becomes a passing stage.
 if(!report.providerContextContribution.some(context=>context.cceAccepted>0&&context.graphifyNodes>0))report.failures.push('Actual context lacks accepted CCE and Graphify contribution.');
 if(!report.discovered||!report.enabled||!report.connected||!report.invoked||!report.enforcementTested)report.failures.push('One or more native discovery/enablement/connection/invocation/enforcement stages lack evidence.');
 if(report.scenarios.filter(scenario=>scenario.id!=='mutation-guard').some(scenario=>!scenario.nativeQuestionCalls&&!scenario.questionsInChat))report.failures.push('Requirements questioning lacks native/chat evidence.');
 report.passed=report.failures.length===0;
 if(report.passed) report.evidence="native-host";
} catch(error){report.failures.push(String(error.message).slice(0,1200));report.passed=false;}
finally{await mkdir(path.dirname(path.resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({host,candidateHash,report:path.resolve(output),passed:report.passed,failures:report.failures}));await rm(workspace,{recursive:true,force:true});if(!report.passed)process.exitCode=1;}
