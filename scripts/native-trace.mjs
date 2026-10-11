/** Normalize documented native tool events; prose cannot establish invocation. */
export function parseNativeTrace(host, stdout) {
 const events=stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
 const calls=[];
 const resultItems=events.flatMap(event=>event.message?.content??[]).filter(item=>item.type==='tool_result');
 for(const event of events) {
  for(const item of [event.item,...(event.message?.content??[])].filter(Boolean)) {
   if(!['tool_use','mcp_tool_call'].includes(item.type))continue;
   const response=resultItems.find(result=>result.tool_use_id===item.id);
   calls.push({...item,name:item.name??item.tool,input:item.input??item.arguments,status:response&&!response.is_error?'completed':item.status,error:response?.is_error||item.error,result:response?.content??item.result});
  }
  const step=event.step_update;
  if(host==='antigravity-cli'&&event.event==='step_update'&&step?.step_type==='tool'&&['DONE','ERROR'].includes(step.state)) {
   const info=step.tool_info??{};const parameters=info.parameters??{};
   const server=parameters.ServerName??parameters.serverName??parameters.server_name;
   const name=parameters.ToolName??parameters.toolName??parameters.tool_name;
   calls.push({name:info.name==='call_mcp_tool'&&server&&name?`mcp__${server}__${name}`:info.name??step.tool_name,server,input:parameters,status:info.error||step.state==='ERROR'?'failed':'completed',error:info.error,result:info.output});
  }
 }
 const text=events.flatMap(event=>[typeof event.result==='string'?event.result:'',event.result?.response??'',event.step_update?.step_type==='agent_response'?event.step_update.text_delta??'':'',event.item?.type==='agent_message'?event.item.text??'':'',...(event.message?.content??[]).filter(item=>item.type==='text').map(item=>item.text??'')]).join('\n');
 const terminal=events.findLast(event=>event.type==='result'||event.event==='result');
 return {calls,questionsInChat:/\?/.test(text),terminalStatus:terminal?.subtype??terminal?.result?.status,structuredErrors:events.filter(event=>event.type==='error'||event.error||event.result?.error||event.is_error||event.step_update?.tool_info?.error).map(event=>String(event.error?.message??event.error??event.result?.error??event.step_update?.tool_info?.error?.message??event.subtype??''))};
}
