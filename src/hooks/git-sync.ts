import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import * as path from "node:path";

const POST_COMMIT_HOOK = `#!/bin/sh
# GraphWard: auto-sync after commit
npx gw sync . --incremental --silent 2>/dev/null || true
`;

const POST_MERGE_HOOK = `#!/bin/sh
# GraphWard: auto-sync after merge
npx gw sync . --incremental --silent 2>/dev/null || true
`;

export async function installGitHooks(root: string): Promise<{ installed: string[] }> {
  const gitDir = path.join(root, ".git");
  if (!existsSync(gitDir)) {
    throw new Error(`No .git directory found at ${root}. Initialize a git repository first.`);
  }

  const hooksDir = path.join(gitDir, "hooks");
  await mkdir(hooksDir, { recursive: true });

  const installed: string[] = [];

  for (const [name, content] of [
    ["post-commit", POST_COMMIT_HOOK],
    ["post-merge", POST_MERGE_HOOK],
  ] as const) {
    const hookPath = path.join(hooksDir, name);
    if (existsSync(hookPath)) {
      // Don't overwrite existing hooks — append instead
      const { readFile } = await import("node:fs/promises");
      const existing = await readFile(hookPath, "utf8");
      if (existing.includes("graphward")) {
        continue; // already installed
      }
      const appended = existing.trimEnd() + "\n\n" + content.split("\n").slice(1).join("\n");
      await writeFile(hookPath, appended, "utf8");
    } else {
      await writeFile(hookPath, content, "utf8");
    }
    await chmod(hookPath, 0o755);
    installed.push(name);
  }

  return { installed };
}

export async function uninstallGitHooks(root: string): Promise<void> {
  const hooksDir = path.join(root, ".git", "hooks");
  const { readFile: rf } = await import("node:fs/promises");

  for (const name of ["post-commit", "post-merge"]) {
    const hookPath = path.join(hooksDir, name);
    if (!existsSync(hookPath)) continue;

    const content = await rf(hookPath, "utf8");
    if (!content.includes("graphward")) continue;

    // Remove GraphWard lines
    const lines = content.split("\n");
    const filtered = lines.filter(
      (line) => !line.includes("graphward") && !line.includes("GraphWard")
    );
    const result = filtered.join("\n").trim();
    if (result === "#!/bin/sh" || result === "") {
      const { unlink } = await import("node:fs/promises");
      await unlink(hookPath);
    } else {
      await writeFile(hookPath, result + "\n", "utf8");
    }
  }
}
