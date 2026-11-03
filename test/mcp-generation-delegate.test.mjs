/**
 * Stale MCP generation delegation.
 *
 * Rebuilding dist/ under a running MCP server used to make it refuse every call,
 * including propose_task_contract, until a human reconnected it. A server whose
 * loaded generation is stale now forwards calls to a child started from the
 * current identity-verified build, and refuses only when that build is invalid.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const MARKER = 'Current-generation marker description.';

async function isolatedInstall(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gw-mcp-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'pkg');
  const project = path.join(root, 'project');
  await mkdir(pkg, { recursive: true });
  await cp(path.join(checkout, 'dist'), path.join(pkg, 'dist'), { recursive: true });
  await cp(path.join(checkout, 'package.json'), path.join(pkg, 'package.json'));
  await symlink(path.join(checkout, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
  await mkdir(path.join(project, '.graphward', 'knowledge-base'), { recursive: true });
  return { pkg, project };
}

// A rebuild: change a finalized module and re-finalize the identity manifest.
async function rebuild(pkg, relative, edit) {
  const file = path.join(pkg, 'dist', relative);
  await writeFile(file, edit(await readFile(file, 'utf8')));
  const identityPath = path.join(pkg, 'dist', 'runtime-identity.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  identity.modules[relative] = createHash('sha256').update(await readFile(file)).digest('hex');
  identity.generation = createHash('sha256').update(JSON.stringify(identity.modules)).digest('hex');
  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
}

async function connect(t, pkg, project) {
  const client = new Client({ name: 'generation-test', version: '1.0.0' });
  const changes = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changes.push(Date.now()); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, 'dist', 'mcp', 'cli.js'), project], stderr: 'pipe' }));
  t.after(() => client.close());
  return { client, changes };
}

const proposeDescription = async client => (await client.listTools()).tools.find(tool => tool.name === 'propose_task_contract')?.description;

test('a stale server delegates to the current verified build instead of refusing', { timeout: 60000 }, async t => {
  const { pkg, project } = await isolatedInstall(t);
  const { client, changes } = await connect(t, pkg, project);
  assert.ok(!(await client.callTool({ name: 'read_knowledge', arguments: { root: project } })).isError);
  assert.notEqual(await proposeDescription(client), MARKER);

  await rebuild(pkg, 'mcp/consolidated.js', source => source.replace(
    'Record complete scope/questions/answers under an independent task revision. This cannot approve itself. Show the contract and exact confirmation challenge to the user, reuse previous decisions, and bind the native host/session.',
    MARKER,
  ));

  const [first, second] = await Promise.all([
    client.callTool({ name: 'read_knowledge', arguments: { root: project } }),
    client.callTool({ name: 'read_knowledge', arguments: { root: project } }),
  ]);
  assert.ok(!first.isError, JSON.stringify(first.content));
  assert.ok(!second.isError, JSON.stringify(second.content));
  assert.equal(await proposeDescription(client), MARKER, 'tools/list must come from the current build');
  assert.equal(changes.length, 1, 'the host is told once that the tool list changed');

  const proposed = await client.callTool({ name: 'propose_task_contract', arguments: { root: project, host: 'claude-code', sessionId: 'generation-test', contract: { kind: 'fix', request: 'Delegated proposal', intendedUsers: ['agents'], behavior: ['b'], nonGoals: ['n'], acceptanceCriteria: ['a'], scope: ['src/'], constraints: [], questions: [] } } });
  assert.ok(!proposed.isError, JSON.stringify(proposed.content));
  assert.match(proposed.content[0].text, /confirmation-required/);
});

test('a stale server still refuses when the build on disk is not a valid generation', { timeout: 60000 }, async t => {
  const { pkg, project } = await isolatedInstall(t);
  const { client } = await connect(t, pkg, project);
  const module = path.join(pkg, 'dist', 'telemetry', 'index.js');
  await writeFile(module, `${await readFile(module, 'utf8')}\n// unfinalized drift\n`);

  const result = await client.callTool({ name: 'read_knowledge', arguments: { root: project } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Restart this connection/);
});
