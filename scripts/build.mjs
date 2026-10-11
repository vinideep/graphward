// Compile into staging. A failed compiler must not destroy the linked runtime.
import { existsSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { finalizeBuild } from './finalize-build.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
if(existsSync(path.join(root,'src/cli/index.ts'))) {
 const require=createRequire(path.join(root,'package.json'));let compiler;
 try{compiler=require.resolve('typescript/bin/tsc');}catch{throw Error('GraphWard source build requires local development dependencies. Run npm ci before building or linking.');}
 const staging=path.join(root,`.dist-build-${randomUUID()}`),previous=path.join(root,`.dist-previous-${randomUUID()}`),target=path.join(root,'dist');
 try {
  const result=spawnSync(process.execPath,[compiler,'-p',path.join(root,'tsconfig.json'),'--outDir',staging,'--noEmitOnError'],{cwd:root,stdio:'inherit'});
  if(result.error||result.status!==0){process.exitCode=result.status??1;process.stderr.write('Build failed; the previous GraphWard runtime was retained.\n');}
  else {
   finalizeBuild(root,staging);
   if(existsSync(target))renameSync(target,previous);
   try{renameSync(staging,target);}catch(error){if(existsSync(previous)&&!existsSync(target))renameSync(previous,target);throw error;}
   rmSync(previous,{recursive:true,force:true});
  }
 }finally{rmSync(staging,{recursive:true,force:true});}
}else {
 if(!process.argv.includes('--prepare'))throw Error('This package contains compiled output only; rebuild from a source checkout.');
 finalizeBuild(root);
}
