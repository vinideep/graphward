import assert from "node:assert/strict";
import test from "node:test";
import { computeTestImpact } from "../dist/verify/impact.js";

test("computeTestImpact finds affected tests using reverse dependency traversal", () => {
  const graph = {
    schemaVersion: 1,
    graphType: "dependency",
    generatedAt: "",
    scope: "",
    unknowns: [],
    nodes: [
      { id: "src/a.js", kind: "file", label: "", confidence: "verified", evidence: [], metadata: {}, path: "src/a.js" },
      { id: "src/b.js", kind: "file", label: "", confidence: "verified", evidence: [], metadata: {}, path: "src/b.js" },
      { id: "test/a.test.js", kind: "file", label: "", confidence: "verified", evidence: [], metadata: {}, path: "test/a.test.js" },
      { id: "test/b.test.js", kind: "file", label: "", confidence: "verified", evidence: [], metadata: {}, path: "test/b.test.js" },
    ],
    edges: [
      { from: "test/a.test.js", to: "src/a.js", relation: "imports", confidence: "verified", evidence: [], metadata: {} },
      { from: "test/b.test.js", to: "src/b.js", relation: "imports", confidence: "verified", evidence: [], metadata: {} },
      { from: "src/b.js", to: "src/a.js", relation: "imports", confidence: "verified", evidence: [], metadata: {} }
    ]
  };

  // 1. Change src/b.js -> affects test/b.test.js
  const impact1 = computeTestImpact(["src/b.js"], graph);
  assert.deepEqual(impact1.affectedTests, ["test/b.test.js"]);
  assert.deepEqual(impact1.reason.get("test/b.test.js"), ["src/b.js"]);

  // 2. Change src/a.js -> affects test/a.test.js AND test/b.test.js (via b.js)
  const impact2 = computeTestImpact(["src/a.js"], graph);
  assert.ok(impact2.affectedTests.includes("test/a.test.js"));
  assert.ok(impact2.affectedTests.includes("test/b.test.js"));

  // 3. Unrelated file
  const impact3 = computeTestImpact(["src/unknown.js"], graph);
  assert.deepEqual(impact3.affectedTests, []);
});
