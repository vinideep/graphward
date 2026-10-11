import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const tests = (await readdir('test')).filter(file => file.endsWith('.test.mjs')).sort().map(file => `test/${file}`);
if (!tests.length) throw new Error('No tests discovered.');
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
