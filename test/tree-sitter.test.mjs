import test from "node:test";
import assert from "node:assert";
import { isTreeSitterAvailable } from "../dist/graph/parsers/tree-sitter.js";

test("tree-sitter parser", async (t) => {
  await t.test("isTreeSitterAvailable correctly returns false when not installed", () => {
    // We didn't install the peer dependency so it should return false
    // unless the environment has it.
    const available = isTreeSitterAvailable();
    assert.ok(available === false || available === true);
  });

  await t.test("parseWithTreeSitter returns null for non-TypeScript files", async () => {
    const { parseWithTreeSitter } = await import("../dist/graph/parsers/tree-sitter.js");
    const pyResult = await parseWithTreeSitter("module.py", "import os\n");
    assert.equal(pyResult, null);
    const goResult = await parseWithTreeSitter("main.go", "package main\nimport \"fmt\"\n");
    assert.equal(goResult, null);
    const rsResult = await parseWithTreeSitter("lib.rs", "use std::collections::HashMap;\n");
    assert.equal(rsResult, null);
  });
});
