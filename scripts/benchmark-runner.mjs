#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--models')) throw new Error('Model runs require separately recorded native-host runs; dry-run never invokes a model. Use evaluate-agent-runs.mjs --results <measured-runs.json>.');
if (args.some(argument => argument !== '--dry-run')) throw new Error('Only --dry-run is supported by the isolated deterministic harness.');
const workspace = await mkdtemp(path.join(tmpdir(), 'graphward-benchmark-'));
const fixture = path.join(workspace, 'project');
const checks = [];
try {
  await cp(path.join(root, 'benchmark/complex-backend'), fixture, { recursive: true, filter: source => !/(?:^|[/\\])(?:node_modules|dist|\.graphward)(?:[/\\]|$)/.test(source) });
  await mkdir(path.join(fixture, '.graphward'), { recursive: true });
  await writeFile(path.join(fixture, '.graphward/gw.config.json'), JSON.stringify({ providers: { policy: 'native' } }));
  for (const arguments_ of [['map', fixture], ['context', 'Inspect order behavior and callers', fixture, '--json']]) {
    const started = performance.now();
    try { execFileSync(process.execPath, [path.join(root, 'dist/cli/index.js'), ...arguments_], { cwd: fixture, timeout: 120000, stdio: 'pipe' }); checks.push({ command: arguments_[0], exitCode: 0, timedOut: false, latencyMs: performance.now() - started }); }
    catch (error) { checks.push({ command: arguments_[0], exitCode: error.status ?? 1, timedOut: error.code === 'ETIMEDOUT', error: String(error.stderr ?? error.message).slice(-1500) }); }
  }
  const result = { evidence: 'deterministic-fixture', modelInvocations: 0, agentAccuracy: 'unavailable', isolated: true, checks, passed: checks.length > 0 && checks.every(check => check.exitCode === 0 && !check.timedOut) };
  console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
} finally { await rm(workspace, { recursive: true, force: true }); }
