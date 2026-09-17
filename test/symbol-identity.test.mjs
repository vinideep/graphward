import test from "node:test";
import assert from "node:assert/strict";
import {
  createSymbolId,
  formatSymbolUri,
  parseSymbolUri,
  computeSignatureHash,
  computeDeclarationHash,
  getOverloadQualifiedName,
  resolveRuntimeSymbol,
} from "../dist/graph/symbol-identity.js";

test("symbol-identity: createSymbolId and normalization", () => {
  const sym = createSymbolId({
    repository: "graphward-os",
    package: "core",
    language: "typescript",
    path: "src/payment/checkout.ts",
    qualifiedName: "PaymentService.pay",
    signature: "(amount: number, currency: string): Promise<PaymentResult>",
  });

  assert.equal(sym.repository, "graphward-os");
  assert.equal(sym.package, "core");
  assert.equal(sym.language, "typescript");
  assert.equal(sym.path, "src/payment/checkout.ts");
  assert.equal(sym.qualifiedName, "PaymentService.pay");
  assert.ok(sym.signature);
  assert.ok(sym.declarationHash, "declarationHash should be auto-computed");
  assert.equal(sym.declarationHash.length, 16);
});

test("symbol-identity: inferLanguageFromPath", () => {
  const pySym = createSymbolId({
    path: "server/worker.py",
    qualifiedName: "handle_job",
  });
  assert.equal(pySym.language, "python");

  const goSym = createSymbolId({
    path: "pkg/api/server.go",
    qualifiedName: "Server.Start",
  });
  assert.equal(goSym.language, "go");

  const rsSym = createSymbolId({
    path: "src/lib.rs",
    qualifiedName: "Engine::run",
  });
  assert.equal(rsSym.language, "rust");
});

test("symbol-identity: gw:// URI formatting and parsing round-trip", () => {
  const sym = createSymbolId({
    repository: "my-repo",
    package: "payments",
    language: "typescript",
    path: "src/services/stripe.ts",
    qualifiedName: "StripeClient.charge",
    signature: "(token: string, amount: number): Promise<boolean>",
  });

  const uri = formatSymbolUri(sym);
  assert.ok(uri.startsWith("gw://my-repo/payments/typescript/src/services/stripe.ts#StripeClient.charge"));
  assert.ok(uri.includes("?sig="));

  const parsed = parseSymbolUri(uri);
  assert.equal(parsed.repository, "my-repo");
  assert.equal(parsed.package, "payments");
  assert.equal(parsed.language, "typescript");
  assert.equal(parsed.path, "src/services/stripe.ts");
  assert.equal(parsed.qualifiedName, "StripeClient.charge");
  assert.equal(parsed.declarationHash, sym.declarationHash, "declarationHash must be preserved across URI round-trip");
  assert.equal(parsed.origin, "SOURCE");
});

test("symbol-identity: SymbolOrigin round-trip across all origin variants", () => {
  const origins = ["SOURCE", "GENERATED", "DEPENDENCY", "VIRTUAL"];
  for (const origin of origins) {
    const sym = createSymbolId({
      repository: "repo",
      package: "pkg",
      language: "typescript",
      path: "src/types.ts",
      qualifiedName: `Type_${origin}`,
      origin,
    });
    assert.equal(sym.origin, origin);

    const uri = formatSymbolUri(sym);
    const parsed = parseSymbolUri(uri);
    assert.equal(parsed.origin, origin, `Origin ${origin} must be preserved across format/parse round-trip`);
    assert.equal(parsed.qualifiedName, `Type_${origin}`);
  }
});

test("symbol-identity: URI validation rejects malformed URIs", () => {
  assert.throws(() => parseSymbolUri("http://example.com"), /must start with 'gw:\/\/'/);
  assert.throws(() => parseSymbolUri("gw://missing-hash-fragment"), /missing '#' fragment/);
  assert.throws(() => parseSymbolUri("gw://too/short#sym"), /must contain repo\/package\/lang\/path/);
});

test("symbol-identity: signature hashing and overload naming", () => {
  const sig1 = "(amount: number): void";
  const sig2 = "(amount: number, currency: string): void";

  const hash1 = computeSignatureHash(sig1);
  const hash2 = computeSignatureHash(sig2);
  assert.notEqual(hash1, hash2);

  const overload1 = getOverloadQualifiedName("pay", sig1);
  const overload2 = getOverloadQualifiedName("pay", sig2);
  assert.notEqual(overload1, overload2);
  assert.ok(overload1.startsWith("pay@"));
  assert.ok(overload2.startsWith("pay@"));
});

test("symbol-identity: resolveRuntimeSymbol sourcemap bridge", () => {
  // 1. Without sourcemap (fallback to runtime hint)
  const rawResolved = resolveRuntimeSymbol({
    moduleId: "dist/bundle.js",
    runtimeSymbolHint: "t_pay",
    callsite: { file: "dist/bundle.js", line: 142, column: 10 },
  });
  assert.equal(rawResolved.sourceMapped, false);
  assert.equal(rawResolved.qualifiedName, "t_pay");
  assert.equal(rawResolved.file, "dist/bundle.js");

  // 2. With sourcemap lookup function
  const mappedResolved = resolveRuntimeSymbol(
    {
      moduleId: "dist/bundle.js",
      runtimeSymbolHint: "t_pay",
      callsite: { file: "dist/bundle.js", line: 142, column: 10 },
    },
    (file, line) => {
      if (file === "dist/bundle.js" && line === 142) {
        return {
          sourceFile: "src/payment/checkout.ts",
          sourceLine: 24,
          sourceColumn: 5,
          sourceSymbol: "PaymentService.pay",
        };
      }
      return null;
    },
  );

  assert.equal(mappedResolved.sourceMapped, true);
  assert.equal(mappedResolved.file, "src/payment/checkout.ts");
  assert.equal(mappedResolved.qualifiedName, "PaymentService.pay");
  assert.equal(mappedResolved.line, 24);
  assert.ok(mappedResolved.uri?.startsWith("gw://"));
});
