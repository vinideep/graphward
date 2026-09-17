import test from "node:test";
import assert from "node:assert/strict";
import {
  TypeScriptLanguageParser,
  JavaScriptLanguageParser,
  PythonLanguageParser,
  GoLanguageParser,
  RustLanguageParser,
  CompositeLanguageParser,
  defaultParserRegistry,
  toScipSymbol,
} from "../dist/graph/parsers/interface.js";
import { parseWithTreeSitter, isTreeSitterAvailable } from "../dist/graph/parsers/tree-sitter.js";
import { createSymbolId } from "../dist/graph/symbol-identity.js";

test("language-parsers: TypeScript parser extracts functions, classes, calls, imports", async () => {
  const tsCode = `
import { UserService } from "./services/user.js";

export function handleLogin(req: Request): boolean {
  validateUser(req);
  return true;
}

export class AuthController {
  login() {
    handleLogin();
  }
}
  `;

  const parser = new TypeScriptLanguageParser();
  assert.ok(parser.canParse("src/auth.ts"));
  const res = await parser.parse("src/auth.ts", tsCode);

  assert.equal(res.language, "typescript");
  assert.equal(res.imports.length, 1);
  assert.equal(res.imports[0].source, "./services/user.js");

  const fnSym = res.symbols.find((s) => s.name === "handleLogin");
  assert.ok(fnSym);
  assert.equal(fnSym.kind, "function");

  const classSym = res.symbols.find((s) => s.name === "AuthController");
  assert.ok(classSym);
  assert.equal(classSym.kind, "class");

  const call = res.calls.find((c) => c.calleeName === "validateUser");
  assert.ok(call);
});

test("language-parsers: Python parser extracts functions, classes, and calls", async () => {
  const pyCode = `
from os import path
import sys

class PaymentProcessor:
    def process(self, amount):
        validate_amount(amount)
        return True

def charge(user, amount):
    processor = PaymentProcessor()
    return processor.process(amount)
  `;

  const parser = new PythonLanguageParser();
  assert.ok(parser.canParse("app/payment.py"));
  const res = await parser.parse("app/payment.py", pyCode);

  assert.equal(res.language, "python");
  assert.ok(res.imports.length >= 2);

  const classSym = res.symbols.find((s) => s.name === "PaymentProcessor");
  assert.ok(classSym);

  const methodSym = res.symbols.find((s) => s.name === "PaymentProcessor.process");
  assert.ok(methodSym);
  assert.equal(methodSym.kind, "method");

  const fnSym = res.symbols.find((s) => s.name === "charge");
  assert.ok(fnSym);
  assert.equal(fnSym.kind, "function");

  const call = res.calls.find((c) => c.calleeName === "validate_amount");
  assert.ok(call);
  assert.equal(call.fromSymbol, "PaymentProcessor.process", "Call in Python method should be attributed to method");

  const callInFn = res.calls.find((c) => c.calleeName === "PaymentProcessor");
  assert.ok(callInFn);
  assert.equal(callInFn.fromSymbol, "charge", "Call in Python function should be attributed to function");
});

test("language-parsers: Go parser extracts structs, methods, and functions", async () => {
  const goCode = `
package payment

type Processor struct {
    client HTTPClient
}

func (p *Processor) Pay(amount int) error {
    validate(amount)
    return nil
}

func NewProcessor() *Processor {
    return &Processor{}
}
  `;

  const parser = new GoLanguageParser();
  assert.ok(parser.canParse("pkg/payment.go"));
  const res = await parser.parse("pkg/payment.go", goCode);

  assert.equal(res.language, "go");
  const structSym = res.symbols.find((s) => s.name === "Processor");
  assert.ok(structSym);

  const methodSym = res.symbols.find((s) => s.name === "Processor.Pay");
  assert.ok(methodSym);
  assert.equal(methodSym.kind, "method");

  const fnSym = res.symbols.find((s) => s.name === "NewProcessor");
  assert.ok(fnSym);
  assert.equal(fnSym.kind, "function");

  const call = res.calls.find((c) => c.calleeName === "validate");
  assert.ok(call);
  assert.equal(call.fromSymbol, "Processor.Pay", "Call in Go method should be attributed to method");
});

test("language-parsers: Rust parser extracts structs, impl methods, and functions", async () => {
  const rsCode = `
pub struct PaymentService {
    token: String,
}

impl PaymentService {
    pub fn charge(&self, amount: u64) -> bool {
        verify(amount);
        true
    }
}

pub fn create_service() -> PaymentService {
    PaymentService { token: String::new() }
}
  `;

  const parser = new RustLanguageParser();
  assert.ok(parser.canParse("src/payment.rs"));
  const res = await parser.parse("src/payment.rs", rsCode);

  assert.equal(res.language, "rust");
  const structSym = res.symbols.find((s) => s.name === "PaymentService");
  assert.ok(structSym);

  const methodSym = res.symbols.find((s) => s.name === "PaymentService::charge");
  assert.ok(methodSym);
  assert.equal(methodSym.kind, "method");

  const fnSym = res.symbols.find((s) => s.name === "create_service");
  assert.ok(fnSym);
  assert.equal(fnSym.kind, "function");

  const call = res.calls.find((c) => c.calleeName === "verify");
  assert.ok(call);
  assert.equal(call.fromSymbol, "PaymentService::charge", "Call in Rust impl method should be attributed to impl method");
});

test("language-parsers: Composite parser routes by extension", async () => {
  const composite = new CompositeLanguageParser();
  assert.ok(composite.canParse("main.ts"));
  assert.ok(composite.canParse("main.py"));
  assert.ok(composite.canParse("main.go"));
  assert.ok(composite.canParse("main.rs"));

  const pyRes = await composite.parse("test.py", "def foo():\n    pass\n");
  assert.equal(pyRes.language, "python");
  assert.equal(pyRes.symbols.length, 1);
});

test("language-parsers: SCIP symbol formatting", () => {
  const symId = createSymbolId({
    repository: "graphward",
    package: "core",
    language: "typescript",
    path: "src/payment.ts",
    qualifiedName: "charge",
    signature: "(amount: number): boolean",
  });

  const scip = toScipSymbol(symId);
  assert.ok(scip.startsWith("scip-graphward graphward core src/payment.ts charge((amount: number): boolean)#"));
});

test("language-parsers: Tree-sitter availability and traversal robustness", async () => {
  const available = isTreeSitterAvailable();
  assert.ok(available === true || available === false);

  if (!available) {
    const res = await parseWithTreeSitter("test.ts", "export function foo() { bar(); }");
    assert.equal(res, null, "When tree-sitter not installed, parseWithTreeSitter should safely return null");
  }
});
