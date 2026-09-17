import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTypeScriptCompiler,
  discoverTsConfigs,
  TypeScriptCompilerResolver,
} from "../dist/graph/parsers/typescript-compiler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

test("typescript-compiler: loads TypeScript compiler from host/bundled", async () => {
  const ts = await loadTypeScriptCompiler(REPO_ROOT);
  assert.ok(ts, "TypeScript compiler should load successfully");
  assert.ok(typeof ts.createProgram === "function");
});

test("typescript-compiler: discovers real tsconfig hierarchy in project", async () => {
  const ts = await loadTypeScriptCompiler(REPO_ROOT);
  const configs = discoverTsConfigs(REPO_ROOT, ts);
  assert.ok(configs.size > 0, "Should find at least one tsconfig in project root");
  const rootConfigPath = path.resolve(REPO_ROOT, "tsconfig.json");
  assert.ok(configs.has(rootConfigPath), "Should contain root tsconfig.json");
});

test("typescript-compiler: resolver analyzes file, symbols, and dynamic calls", async () => {
  const resolver = new TypeScriptCompilerResolver(REPO_ROOT);
  const ready = await resolver.initialize();
  assert.ok(ready);
  assert.ok(resolver.isAvailable());

  const sampleCode = `
export interface PaymentService {
  pay(amount: number): boolean;
}

export class StripeService implements PaymentService {
  pay(amount: number): boolean {
    return true;
  }
}

export function executePayment(service: any, method: string) {
  // Static call
  console.log("Processing payment");
  // Dynamic element access call
  service[method]();
}
  `;

  const analysis = await resolver.analyzeFile("src/temp-test-payment.ts", sampleCode);
  assert.equal(analysis.compilerAvailable, true);

  // Check interface
  const iface = analysis.symbols.find((s) => s.name === "PaymentService");
  assert.ok(iface, "PaymentService interface should be detected");
  assert.equal(iface.isInterface, true);

  // Check class & implementation
  const cls = analysis.symbols.find((s) => s.name === "StripeService");
  assert.ok(cls, "StripeService class should be detected");
  const impl = analysis.implementations.find((i) => i.className === "StripeService" && i.interfaceName === "PaymentService");
  assert.ok(impl, "StripeService implements PaymentService should be recorded");

  // Check dynamic call detection
  assert.ok(analysis.dynamicCalls.length > 0, "Dynamic element call service[method]() should be detected");
  const dynCall = analysis.calls.find((c) => c.isDynamic);
  assert.ok(dynCall, "Dynamic call should be marked in calls");
  assert.ok(dynCall.why.includes("dynamic property access"));

  // Check evidence generated
  assert.ok(analysis.evidence.length > 0, "Evidence records should be emitted");
  assert.equal(analysis.evidence[0].kind, "COMPILER");
  assert.equal(analysis.evidence[0].source.type, "SOURCE");
  assert.equal(analysis.evidence[0].confidenceState, "CALIBRATED");
});

test("typescript-compiler: handles overloaded methods and alias symbols without crashing", async () => {
  const resolver = new TypeScriptCompilerResolver(REPO_ROOT);
  await resolver.initialize();

  const overloadCode = `
export class MultiWorker {
  process(task: string): string;
  process(task: number): number;
  process(task: string | number): string | number {
    return task;
  }
}

export function runMulti(worker: MultiWorker) {
  worker.process("hello");
  worker.process(42);
}
  `;

  const analysis = await resolver.analyzeFile("src/temp-overload.ts", overloadCode);
  assert.equal(analysis.compilerAvailable, true);

  const workerCls = analysis.symbols.find((s) => s.name === "MultiWorker");
  assert.ok(workerCls);

  const calls = analysis.calls.filter((c) => c.callerSymbol === "runMulti");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].calleeName, "worker.process");
  assert.equal(calls[1].calleeName, "worker.process");
});
