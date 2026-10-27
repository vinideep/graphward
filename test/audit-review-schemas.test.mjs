import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {createReviewBinding} from '../dist/gates/review-evidence.js';
import {captureApiSnapshot,replayApiSnapshot} from '../dist/gates/api-snapshot.js';

async function validator(name){const ajv=new Ajv2020({allErrors:true});addFormats(ajv);return ajv.compile(JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`,import.meta.url),'utf8')));}
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'gw-review-schema-'));await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src/a.ts'),'export const a=1;\n');return root;}
test('F04/F07 public completed review schemas accept current bindings and reject legacy/unattributed evidence',async()=>{
 const root=await fixture(),binding=await createReviewBinding(root,['src/a.ts']);
 for(const name of ['security-review','convention-findings']){
  const valid=await validator(name),review={schemaVersion:1,status:'complete',reviewer:'schema contract fixture',reviewedAt:new Date().toISOString(),binding,findings:[]};
  assert.equal(valid(review),true,JSON.stringify(valid.errors));assert.equal(valid({}),false);assert.equal(valid({...review,status:'pending'}),false);const stale=structuredClone(review);stale.binding.runtimeGeneration='unbound';assert.equal(valid(stale),false);
  const security=name==='security-review';const finding={severity:security?'high':'major',message:'fixture finding',...(security?{}:{confidence:0.9,adherence:0.9}),waiver:{[security?'reviewer':'owner']:'reviewer',rationale:'documented temporary exception'}};
  assert.equal(valid({...review,findings:[finding]}),false,'schema must not accept an undated indefinite waiver');finding.waiver.expiresAt='2099-01-01T00:00:00Z';assert.equal(valid({...review,findings:[finding]}),true,JSON.stringify(valid.errors));
 }
});
test('F06 public snapshot schemas validate actual v2 capture/replay and reject a pending or inconsistent pass',async()=>{
 const root=await fixture();const exchange={request:{method:'GET',path:'/fixture'},response:{status:200,body:{value:1}}};
 const {manifest}=await captureApiSnapshot(root,'fixture',exchange,{sourceFiles:['src/a.ts']});const report=await replayApiSnapshot(root,'fixture',exchange);
 const baseline=await validator('api-snapshot'),replay=await validator('api-snapshot-replay');assert.equal(baseline(manifest),true,JSON.stringify(baseline.errors));assert.equal(replay(report),true,JSON.stringify(replay.errors));assert.equal(baseline({...manifest,schemaVersion:1}),false);assert.equal(replay({...report,status:'pending'}),false);assert.equal(replay({...report,differences:['unexpected']}),false);const unbound=structuredClone(report);delete unbound.binding;assert.equal(replay(unbound),false);
});
