import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeSymbolResolver,
  TracePrivacyPolicy,
  RuntimeTracer,
  ExecutionFlowTracker,
  OtlpTraceReceiver,
} from "../dist/runtime/index.js";

test("RuntimeSymbolResolver: exact sourcemap and remapped dist resolution", () => {
  const resolver = new RuntimeSymbolResolver();
  resolver.registerSymbols([
    {
      repository: "default",
      package: "pkg",
      language: "typescript",
      path: "src/billing.ts",
      qualifiedName: "processInvoice",
      declarationHash: "hash1",
      origin: "SOURCE",
    },
    {
      repository: "default",
      package: "pkg",
      language: "typescript",
      path: "src/billing.ts",
      qualifiedName: "cancelInvoice",
      declarationHash: "hash2",
      origin: "SOURCE",
    },
  ]);

  resolver.registerSourceMap("dist/bundle.js", [
    {
      genLine: 100,
      genColumn: 5,
      sourceFile: "src/billing.ts",
      sourceLine: 10,
      symbolName: "processInvoice",
    },
  ]);

  // 1. Exact sourcemap
  const res1 = resolver.resolve({ file: "dist/bundle.js", line: 100, column: 5 });
  assert.equal(res1.status, "RESOLVED");
  assert.equal(res1.resolvedSymbol?.qualifiedName, "processInvoice");
  assert.ok(res1.candidates[0].confidence >= 0.99);

  // 2. Remapped dist file
  const res2 = resolver.resolve({ file: "dist/billing.js", functionName: "cancelInvoice" });
  assert.equal(res2.status, "RESOLVED");
  assert.equal(res2.resolvedSymbol?.qualifiedName, "cancelInvoice");

  // 3. Foreign unknown frame
  const res3 = resolver.resolve({ file: "node_modules/lodash/lodash.js", functionName: "debounce" });
  assert.equal(res3.status, "UNRESOLVED");
});

test("TracePrivacyPolicy: redacts secrets, PII, and strips headers", () => {
  const policy = new TracePrivacyPolicy({
    redactSecrets: true,
    redactPii: true,
    stripHeaders: ["authorization", "cookie"],
    environmentAllowlist: ["dev", "test"],
  });

  // Valid environment with sensitive data
  const rawSpan = {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    name: "POST /auth/login",
    environment: "dev",
    attributes: {
      "http.route": "/auth/login",
      "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID",
      "password": "mySuperSecretPassword123",
      "user.email": "user@example.com",
      "credit_card": "4111 2222 3333 4444",
    },
  };

  const sanitized = policy.sanitizeSpan(rawSpan);
  assert.ok(sanitized !== null);
  assert.equal(sanitized.attributes["authorization"], "[REDACTED_HEADER]");
  assert.equal(sanitized.attributes["password"], "[REDACTED_SENSITIVE]");
  assert.ok(String(sanitized.attributes["user.email"]).includes("[REDACTED_PII]"));
  assert.ok(String(sanitized.attributes["credit_card"]).includes("[REDACTED_PII]"));

  // Disallowed environment
  const prodSpan = { ...rawSpan, environment: "prod_restricted" };
  const prodSanitized = policy.sanitizeSpan(prodSpan);
  assert.equal(prodSanitized, null);
});

test("RuntimeTracer: enforces budget, rate limit, and modes", () => {
  const tracer = new RuntimeTracer("MODE_B_PROBES", {
    level: "BOUNDARY",
    maxSpansPerSec: 10,
    maxInstrumentedSymbols: 2,
    maxOverheadPct: 5.0,
  });

  // Level BOUNDARY symbol check
  assert.equal(tracer.shouldInstrumentSymbol("symA", true), true);
  assert.equal(tracer.shouldInstrumentSymbol("symB", false), false);
  assert.equal(tracer.shouldInstrumentSymbol("symC", true), true);
  // Reached maxInstrumentedSymbols = 2
  assert.equal(tracer.shouldInstrumentSymbol("symD", true), false);

  // Rate limit
  for (let i = 0; i < 10; i++) {
    const ok = tracer.recordSpan({
      traceId: `t_${i}`,
      spanId: `s_${i}`,
      name: "span",
    });
    assert.equal(ok, true);
  }

  // 11th span in same second dropped
  const dropped = tracer.recordSpan({
    traceId: "t_overflow",
    spanId: "s_overflow",
    name: "span",
  });
  assert.equal(dropped, false);

  const stats = tracer.getStats();
  assert.equal(stats.totalSpansRecorded, 10);
  assert.equal(stats.totalSpansDropped, 1);
});

test("ExecutionFlowTracker: aggregates invocations and compares with static graph", () => {
  const tracker = new ExecutionFlowTracker();
  const symCaller = {
    repository: "default",
    package: "pkg",
    language: "typescript",
    path: "src/caller.ts",
    qualifiedName: "runJob",
    declarationHash: "c1",
    origin: "SOURCE",
  };
  const symCalleeA = {
    repository: "default",
    package: "pkg",
    language: "typescript",
    path: "src/calleeA.ts",
    qualifiedName: "saveRecord",
    declarationHash: "cA",
    origin: "SOURCE",
  };
  const symCalleeB = {
    repository: "default",
    package: "pkg",
    language: "typescript",
    path: "src/calleeB.ts",
    qualifiedName: "dynamicHandler",
    declarationHash: "cB",
    origin: "SOURCE",
  };

  // Record 5 invocations of runJob -> saveRecord
  for (let i = 0; i < 5; i++) {
    tracker.recordInvocation(symCaller, symCalleeA, { latencyMs: 12 + i });
  }

  // Record 2 invocations of runJob -> dynamicHandler (dynamic runtime only)
  tracker.recordInvocation(symCaller, symCalleeB, { latencyMs: 50 });

  const statsA = tracker.getNodeStats("src/calleeA.ts#saveRecord");
  assert.equal(statsA?.invocations, 5);
  assert.ok(statsA.p50Ms > 0);

  // Static call graph only knew about caller -> calleeA and caller -> calleeStaticOnly
  const staticEdges = [
    { from: symCaller, to: symCalleeA },
    { from: symCaller, to: "src/dead.ts#neverCalled" },
  ];

  const comparison = tracker.compareObservedVsInferred(staticEdges);
  assert.equal(comparison.concordantEdges.length, 1);
  assert.equal(comparison.concordantEdges[0].count, 5);
  assert.equal(comparison.staticOnlyEdges.length, 1);
  assert.equal(comparison.staticOnlyEdges[0].callee, "src/dead.ts#neverCalled");
  assert.equal(comparison.runtimeOnlyEdges.length, 1);
  assert.equal(comparison.runtimeOnlyEdges[0].callee, "src/calleeB.ts#dynamicHandler");
  assert.ok(comparison.deadCodeRisk.some((r) => r.symbol === "src/dead.ts#neverCalled"));
});

test("TracePrivacyPolicy: redacts multiple PII and secrets in a single string", () => {
  const policy = new TracePrivacyPolicy({ redactPii: true, redactSecrets: true });
  const multiPii = "Send notifications to alice@example.com, bob@example.com and charlie@test.org";
  const sanitized = policy.sanitizeValue(multiPii);
  assert.equal(sanitized, "Send notifications to [REDACTED_PII], [REDACTED_PII] and [REDACTED_PII]");
});

test("RuntimeSymbolResolver: handles async prefix, method paths, and nearest column sourcemap entries", () => {
  const resolver = new RuntimeSymbolResolver();
  resolver.registerSymbols([
    {
      repository: "default",
      package: "pkg",
      language: "typescript",
      path: "src/orders.ts",
      qualifiedName: "processOrder",
      declarationHash: "h1",
      origin: "SOURCE",
    },
  ]);

  // Async function name with class prefix
  const res1 = resolver.resolve({
    file: "src/orders.ts",
    functionName: "async OrderService.processOrder",
  });
  assert.equal(res1.status, "RESOLVED");
  assert.equal(res1.resolvedSymbol?.qualifiedName, "processOrder");

  // Sourcemap with multiple columns on same line -> selects closest column
  resolver.registerSourceMap("dist/orders.min.js", [
    { genLine: 50, genColumn: 0, sourceFile: "src/orders.ts", sourceLine: 1, symbolName: "otherFn" },
    { genLine: 50, genColumn: 120, sourceFile: "src/orders.ts", sourceLine: 10, symbolName: "processOrder" },
  ]);

  const res2 = resolver.resolve({ file: "dist/orders.min.js", line: 50, column: 118 });
  assert.equal(res2.status, "RESOLVED");
  assert.equal(res2.resolvedSymbol?.qualifiedName, "processOrder");
});

test("OtlpTraceReceiver: enforces TracePrivacyPolicy and drops disallowed spans", () => {
  const resolver = new RuntimeSymbolResolver();
  const tracer = new RuntimeTracer();
  const privacy = new TracePrivacyPolicy({
    environmentAllowlist: ["staging"],
    stripHeaders: ["authorization"],
  });
  const receiver = new OtlpTraceReceiver(resolver, tracer, undefined, privacy);

  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "environment", value: { stringValue: "dev_unauthorized" } }] },
        scopeSpans: [{ spans: [{ traceId: "t1", spanId: "s1", name: "span_dev" }] }],
      },
      {
        resource: { attributes: [{ key: "environment", value: { stringValue: "staging" } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "t2",
                spanId: "s2",
                name: "span_staging",
                attributes: [{ key: "authorization", value: { stringValue: "Bearer secret123" } }],
              },
            ],
          },
        ],
      },
    ],
  };

  const summary = receiver.ingestPayload(payload);
  assert.equal(summary.receivedSpans, 2);
  assert.equal(summary.acceptedSpans, 1);
  assert.equal(summary.droppedSpans, 1);
});
