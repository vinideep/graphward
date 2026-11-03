import { spawn, spawnSync } from "node:child_process";

export interface ProcessRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  windowsVerbatimArguments?: boolean;
  onChunk?: (chunk: string, source: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  input?: string | Buffer;
}

export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (request) => {
  return new Promise((resolve) => {
    const args = request.args ?? [];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let cancelled = false;
    const maxBuffer = request.maxBuffer ?? 10 * 1024 * 1024;

    let child;
    try {
      child = spawn(request.command, args, {
        cwd: request.cwd,
        env: request.env,
        windowsHide: true,
        shell: request.shell,
        windowsVerbatimArguments: request.windowsVerbatimArguments,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        command: request.command,
        args,
        exitCode: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const finish = (code: number, error?: string) => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ command: request.command, args, exitCode: cancelled ? 130 : timedOut ? 124 : code, stdout, stderr, timedOut, ...(error ? { error } : {}) });
    };
    const signalTree = (signal: "SIGTERM" | "SIGKILL") => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, signal); } catch { /* group already exited */ }
      } else if (child.pid) {
        // Windows has no POSIX process groups. taskkill /T owns descendants;
        // return remains bounded even if platform cleanup itself is unavailable.
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => {});
        killer.unref();
      }
    };
    const terminate = () => {
      if (settled || killTimer) return;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => { signalTree("SIGKILL"); finish(1); }, 3000);
    };
    const abort = () => { cancelled = true; terminate(); };
    if (request.timeoutMs) timer = setTimeout(() => { timedOut = true; terminate(); }, request.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length <= maxBuffer) {
        stdout += chunk;
      }
      request.onChunk?.(chunk, "stdout");
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length + chunk.length <= maxBuffer) {
        stderr += chunk;
      }
      request.onChunk?.(chunk, "stderr");
    });
    if (request.input !== undefined) child.stdin.end(request.input);

    child.on("error", (error) => {
      finish(1, error instanceof Error ? error.message : String(error));
    });

    child.on("close", (code) => {
      // A timed-out leader can exit before a descendant. Kill the owned group
      // even when inherited pipes happened to close early.
      if (timedOut || cancelled) signalTree("SIGKILL");
      finish(code ?? 1);
    });
  });
};

/** Argument-array synchronous runner for legacy synchronous analysis paths. */
export function runProcessSync(request: ProcessRequest): ProcessResult {
  const args = request.args ?? [];
  const result = spawnSync(request.command, args, {
    cwd: request.cwd,
    env: request.env,
    timeout: request.timeoutMs ?? 30_000,
    maxBuffer: request.maxBuffer ?? 10 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
    input: request.input,
  });
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return {
    command: request.command,
    args,
    exitCode: typeof result.status === "number" ? result.status : timedOut ? 124 : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: Boolean(timedOut),
    ...(result.error ? { error: result.error.message } : {}),
  };
}
