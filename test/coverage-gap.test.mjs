import assert from "node:assert/strict";
import test from "node:test";
import { detectCoverageGaps, generateCharacterizationTests } from "../dist/coverage-gap/index.js";

test("detectCoverageGaps identifies exports without test coverage", () => {
  const graph = {
    schemaVersion: 1,
    graphType: "dependency",
    generatedAt: "",
    scope: "",
    unknowns: [],
    nodes: [
      { id: "src/a.js:foo", kind: "export", label: "foo", confidence: "verified", evidence: [], metadata: {}, path: "src/a.js" },
      { id: "src/a.js:bar", kind: "export", label: "bar", confidence: "verified", evidence: [], metadata: {}, path: "src/a.js" },
      { id: "test/a.test.js", kind: "file", label: "", confidence: "verified", evidence: [], metadata: {}, path: "test/a.test.js" },
    ],
    edges: [
      { from: "test/a.test.js", to: "src/a.js:foo", relation: "imports", confidence: "verified", evidence: [], metadata: {} },
    ]
  };

  const gaps = detectCoverageGaps(["src/a.js"], graph);
  
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].symbol, "bar");
  assert.equal(gaps[0].hasTest, false);
});

test("generateCharacterizationTests generates test files for gaps", () => {
  const gaps = [
    { file: "src/a.ts", symbol: "bar", kind: "export", hasTest: false }
  ];

  const tests = generateCharacterizationTests(gaps, "/root");
  
  assert.equal(tests.length, 1);
  assert.equal(tests[0].testFile, "src/a.test.ts");
  assert.deepEqual(tests[0].coversSymbols, ["bar"]);
  assert.ok(tests[0].content.includes("import { describe, it } from 'node:test'"));
  assert.ok(tests[0].content.includes("import { bar } from './a.js'"));
  assert.ok(tests[0].content.includes("typeof bar !== 'undefined'"));
});
