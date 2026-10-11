import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2);const option=name=>args[args.indexOf(name)+1];
const directory=option('--directory'),output=option('--output');
if(!directory||!path.isAbsolute(directory)||!output)throw Error('Configure an absolute GRAPHWARD_QUALIFICATION_DIR containing candidate-bound IDE evidence and measured held-out runs.');
await mkdir(output,{recursive:true});
for(const file of ['antigravity.json','measured-runs.json']) {
 const content=await readFile(path.join(directory,file),'utf8');JSON.parse(content);
 // Evidence artifacts must not contain credential-shaped data.
 if(/(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|(?:api[_-]?key|password|access_token|refresh_token)"\s*:\s*"[^"\s]{8,})/i.test(content))throw Error('Qualification evidence contains sensitive fields; redact before collection.');
 await writeFile(path.join(output,file),content);
}
