import test from 'node:test';
import assert from 'node:assert/strict';
import {runEndToEndBenchmark} from '../scripts/evaluate-agent-runs.mjs';
const measured = (configuration,repository='held-out-a') => ({evidence:'measured',heldOut:true,configuration,repository,taskId:'task',sourceRevision:'source',requestHash:'request',candidateHash:'candidate',model:'configured',modelVersion:'fixed',checks:[{command:'actual check',exitCode:0,timedOut:false}],regressions:0,requiredChangesMissed:0,unnecessaryChanges:0,clarificationErrors:0,relevantContextMissed:0,latencyMs:20,cost:0});
test('unavailable measurements and simulated predetermined success cannot qualify',async()=>{assert.equal((await runEndToEndBenchmark()).passed,false);assert.equal((await runEndToEndBenchmark([{...measured('graphward'),evidence:'simulated'}])).passed,false);});
test('qualification compares paired fixed identities and fails omissions or speculative additions',async()=>{
 const records=['held-out-a','held-out-b'].flatMap(repository=>[{...measured('baseline',repository),requiredChangesMissed:1},measured('graphward',repository)]);assert.equal((await runEndToEndBenchmark(records)).passed,true);const mismatch=structuredClone(records);mismatch[1].modelVersion='different';assert.equal((await runEndToEndBenchmark(mismatch)).passed,false);const unnecessary=structuredClone(records);unnecessary[1].unnecessaryChanges=1;unnecessary[3].unnecessaryChanges=1;assert.equal((await runEndToEndBenchmark(unnecessary)).passed,false);
});

test('native trace recognizes actual Claude results and Antigravity stream tools without counting prose claims',async()=>{
 const {parseNativeTrace}=await import('../scripts/native-trace.mjs');
 const claude=parseNativeTrace('claude-code',[{message:{content:[{type:'tool_use',id:'ctx',name:'mcp__graphward__get_engineering_context'}]}},{message:{content:[{type:'tool_result',tool_use_id:'ctx',content:'current context',is_error:false}]}},{type:'result',result:'Which acceptance criteria apply?'}].map(event=>JSON.stringify(event)).join('\n'));
 assert.equal(claude.calls[0].status,'completed');assert.equal(claude.questionsInChat,true);
 const agy=parseNativeTrace('antigravity-cli',JSON.stringify({event:'step_update',step_update:{step_type:'tool',state:'DONE',tool_info:{name:'call_mcp_tool',parameters:{ServerName:'graphward',ToolName:'get_engineering_context'},output:'context'}}}));assert.equal(agy.calls[0].name,'mcp__graphward__get_engineering_context');assert.equal(agy.calls[0].status,'completed');
 const denied=parseNativeTrace('antigravity-cli',JSON.stringify({event:'step_update',step_update:{step_type:'tool',state:'ERROR',tool_info:{name:'call_mcp_tool',parameters:{ServerName:'graphward',ToolName:'get_engineering_context'},error:{message:'user denied permission'}}}}));assert.equal(denied.calls[0].status,'failed');assert.equal(denied.calls[0].name,'mcp__graphward__get_engineering_context');assert.deepEqual(denied.structuredErrors,['user denied permission']);
 assert.equal(parseNativeTrace('codex',JSON.stringify({item:{type:'agent_message',text:'I used graphward MCP.'}})).calls.length,0);
});
