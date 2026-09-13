import test from "node:test";
import assert from "node:assert";
import { scanContent, DEFAULT_PATTERNS } from "../dist/manifest/secrets-scan.js";

test("secrets-scan", async (t) => {
  await t.test("should find AWS Access Key", () => {
    const content = "my aws key is AKIA1234567890ABCDEF";
    const result = scanContent(content, "test.txt");
    assert.strictEqual(result.clean, false);
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(result.findings[0].pattern, "AWS Access Key");
  });

  await t.test("should find GitHub PAT", () => {
    const content = "const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';";
    const result = scanContent(content, "test.txt");
    assert.strictEqual(result.clean, false);
    assert.strictEqual(result.findings[0].pattern, "GitHub Personal Access Token");
  });

  await t.test("should return clean for safe content", () => {
    const content = "const message = 'Hello world';\nconsole.log(message);";
    const result = scanContent(content, "test.txt");
    assert.strictEqual(result.clean, true);
    assert.strictEqual(result.findings.length, 0);
  });
});
