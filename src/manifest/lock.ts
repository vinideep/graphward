import * as fs from 'fs/promises';
import * as path from 'path';

export interface LockOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
}

export async function acquireLock(
  root: string,
  options?: LockOptions
): Promise<() => Promise<void>> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const retryIntervalMs = options?.retryIntervalMs ?? 100;
  const staleThresholdMs = 5 * 60 * 1000; // 5 minutes

  const gwDir = path.join(root, '.graphward');
  const lockFile = path.join(gwDir, '.lock');
  
  // We need a unique temp file for atomic rename
  const tempId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const tempFile = path.join(gwDir, `.lock.${tempId}.tmp`);

  await fs.mkdir(gwDir, { recursive: true });

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Check if lock file exists and is stale
      try {
        const stat = await fs.stat(lockFile);
        if (Date.now() - stat.mtimeMs > staleThresholdMs) {
          // Stale lock, try to remove it
          await fs.unlink(lockFile).catch(() => {});
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          throw e;
        }
      }

      // Write temp file
      await fs.writeFile(tempFile, process.pid.toString(), { flag: 'w' });

      // Try atomic rename using hardlink then unlink, or just rename if we can guarantee it won't overwrite?
      // Wait, fs.rename overwrites by default. 
      // Instead, we can use fs.link (hardlink) which fails if target exists, then unlink temp.
      
      try {
        await fs.link(tempFile, lockFile);
        // Link succeeded, we have the lock
        await fs.unlink(tempFile).catch(() => {});
        
        return async () => {
          await fs.unlink(lockFile).catch(() => {});
        };
      } catch (linkError: any) {
        if (linkError.code === 'EEXIST') {
          // Lock already exists, clean up temp and retry
          await fs.unlink(tempFile).catch(() => {});
        } else {
          // Some other error
          await fs.unlink(tempFile).catch(() => {});
          throw linkError;
        }
      }
    } catch (e) {
      // General error, maybe directory issues
      throw e;
    }

    await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
  }

  throw new Error(`Timeout acquiring lock at ${lockFile}`);
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
    await fs.writeFile(filePath, content, 'utf8');
  }, options);
}
