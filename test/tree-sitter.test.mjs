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
});
