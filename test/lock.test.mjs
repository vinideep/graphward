import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { acquireLock, withLock } from '../dist/manifest/lock.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testRoot = path.join(__dirname, '.test-lock-root');

test('lock implementation', async (t) => {
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.mkdir(testRoot, { recursive: true });

  await t.test('basic acquire and release', async () => {
    let executed = false;
    await withLock(testRoot, async () => {
      executed = true;
      const lockExists = await fs.stat(path.join(testRoot, '.graphward', '.lock')).then(() => true).catch(() => false);
      assert.ok(lockExists, 'lock file should exist during execution');
    });
    assert.ok(executed, 'callback should be executed');
    const lockExists = await fs.stat(path.join(testRoot, '.graphward', '.lock')).then(() => true).catch(() => false);
    assert.ok(!lockExists, 'lock file should be removed after execution');
  });

  await t.test('timeout on contention', async () => {
    const release = await acquireLock(testRoot);
    
    await assert.rejects(
      acquireLock(testRoot, { timeoutMs: 200, retryIntervalMs: 50 }),
      /Timeout acquiring lock/
    );

    await release();
  });

  await t.test('stale lock recovery', async () => {
    const gwDir = path.join(testRoot, '.graphward');
    await fs.mkdir(gwDir, { recursive: true });
    const lockFile = path.join(gwDir, '.lock');
    
    // Create a stale lock file
    await fs.writeFile(lockFile, 'stale');
    
    // Set mtime to 6 minutes ago
    const time = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(lockFile, time, time);

    let executed = false;
    await withLock(testRoot, async () => {
      executed = true;
    }, { timeoutMs: 500, retryIntervalMs: 50 });
    
    assert.ok(executed, 'should recover and execute');
  });

  await t.test('parallel-write stress test', async () => {
    const results = [];
    const count = 10;
    
    const tasks = Array.from({ length: count }, async (_, i) => {
      await withLock(testRoot, async () => {
        // Simulate some async work
        await new Promise(resolve => setTimeout(resolve, 10));
        results.push(i);
      }, { timeoutMs: 5000, retryIntervalMs: 20 });
    });

    await Promise.all(tasks);
    assert.strictEqual(results.length, count, 'all tasks should complete successfully');
  });

  await fs.rm(testRoot, { recursive: true, force: true });
});
