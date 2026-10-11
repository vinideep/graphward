import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface LockOptions {
  timeoutMs?: number;
  name?: string;
  retryIntervalMs?: number;
}

export async function acquireLock(root: string, options?: LockOptions): Promise<() => Promise<void>> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const interval = options?.retryIntervalMs ?? 100;
  const directory = path.join(root, '.graphward');
  const lockFile = path.join(directory, options?.name ?? '.lock');
  if (path.dirname(lockFile) !== directory) throw new Error('Lock name must be a basename.');
  await fs.mkdir(directory, { recursive: true });
  const token = randomUUID();
  const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), token });
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const handle = await fs.open(lockFile, 'wx');
      try { await handle.writeFile(owner); } finally { await handle.close(); }
      return async () => {
        // A delayed release must never remove a replacement owner's lock.
        try { if (await fs.readFile(lockFile, 'utf8') === owner) await fs.unlink(lockFile); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const raw = await fs.readFile(lockFile, 'utf8');
        const previous = JSON.parse(raw);
        if (previous.hostname === hostname() && Number.isInteger(previous.pid) && previous.pid > 0 && typeof previous.token === 'string') {
          let dead = false;
          try { process.kill(previous.pid, 0); }
          catch (probe) { dead = (probe as NodeJS.ErrnoException).code === 'ESRCH'; }
          // Age alone cannot establish that an owner is dead.
          if (dead && await fs.readFile(lockFile, 'utf8') === raw) await fs.unlink(lockFile);
        }
      } catch { /* unknown owner is retained */ }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  } while (Date.now() <= deadline);
  throw new Error(`Timeout acquiring lock at ${lockFile}; owner was not proven dead.`);
}

export async function withLock<T>(
  root: string,
  fn: () => Promise<T>,
  options?: LockOptions
): Promise<T> {
  const release = await acquireLock(root, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function writeProtectedFile(
  root: string,
  filePath: string,
  content: string,
  options?: LockOptions
): Promise<void> {
  const { scanContent } = await import('./secrets-scan.js');
  const scanResult = scanContent(content, filePath);
  if (!scanResult.clean) {
    const messages = scanResult.findings.map(f => `${f.pattern} (severity: ${f.severity}) at line ${f.line}`);
    throw new Error(`Refused to write file ${filePath} due to potential secret leakage:\n${messages.join('\n')}`);
  }
  
  await withLock(root, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${randomUUID()}`;
    try { await fs.writeFile(temporary, content, 'utf8'); await fs.rename(temporary, filePath); }
    finally { await fs.rm(temporary, { force: true }); }
  }, options);
}
