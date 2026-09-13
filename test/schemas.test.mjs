import test from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("schemas", async (t) => {
  const schemasDir = new URL("../schemas", import.meta.url).pathname;

  await t.test("dependency-graph.schema.json is valid JSON", async () => {
    const content = await readFile(join(schemasDir, "dependency-graph.schema.json"), "utf8");
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.title, "GraphWard Dependency Graph");
  });

  await t.test("verification-record.schema.json is valid JSON", async () => {
    const content = await readFile(join(schemasDir, "verification-record.schema.json"), "utf8");
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.title, "GraphWard Verification Record");
  });

  await t.test("config.schema.json is valid JSON", async () => {
    const content = await readFile(join(schemasDir, "config.schema.json"), "utf8");
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.title, "GraphWard Project Config");
  });
});
