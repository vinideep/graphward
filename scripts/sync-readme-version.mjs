// npm `version` lifecycle: keep the README source-candidate line on the bumped package version.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {version}=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const readmePath=path.join(root,'README.md');
const readme=readFileSync(readmePath,'utf8');
const date=new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});
const candidate=/(\*\*Current source candidate — )[^:]+(:\*\* this checkout declares package version `)[^`]+(`)/;
if(!candidate.test(readme))throw Error('README.md has no "Current source candidate" version line to update.');
writeFileSync(readmePath,readme.replace(candidate,`$1${date}$2${version}$3`));
process.stdout.write(`README.md source candidate set to ${version}.\n`);
