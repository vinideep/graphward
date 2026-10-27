/**
 * Telemetry tests — real transcript parsing (not a synthetic length/4 model):
 * sum billed input/output tokens, detect get_context usage, split cohorts.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  summarizeTranscript,
  recordFromTranscript,
  aggregate,
  renderReport,
} from "../dist/telemetry/index.js";

async function tmp() { return mkdtemp(path.join(tmpdir(), "ei-tel-")); }

const TRANSCRIPT_WITH_CONTEXT = [
  JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 8000 }, content: [{ type: "tool_use", name: "get_context" }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 1500, output_tokens: 420 }, content: [{ type: "text", text: "done" }] } }),
  "",
].join("\n");

const TRANSCRIPT_NO_CONTEXT = [
  JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 5000, output_tokens: 600 }, content: [{ type: "text", text: "read a lot of files" }] } }),
].join("\n");

test("summarizeTranscript sums usage and detects get_context", () => {
  const s = summarizeTranscript(TRANSCRIPT_WITH_CONTEXT, "s1");
  assert.equal(s.turns, 2);
  assert.equal(s.inputTokens, 2700);
  assert.equal(s.outputTokens, 720);
  assert.equal(s.cacheReadTokens, 8000);
  assert.equal(s.contextUsed, true);
});

test("summarizeTranscript flags contextUsed false when the tool is absent", () => {
  const s = summarizeTranscript(TRANSCRIPT_NO_CONTEXT, "s2");
  assert.equal(s.contextUsed, false);
  assert.equal(s.inputTokens, 5000);
});

test("summarizeTranscript tolerates malformed lines", () => {
  const s = summarizeTranscript("not json\n{bad\n" + TRANSCRIPT_NO_CONTEXT, "s3");
  assert.equal(s.turns, 1);
});

test("recordFromTranscript appends a row; aggregate splits cohorts", async () => {
  const root = await tmp();
  try {
    await mkdir(path.join(root, ".graphward"), { recursive: true });
    const p1 = path.join(root, "t1.jsonl");
    const p2 = path.join(root, "t2.jsonl");
    await writeFile(p1, TRANSCRIPT_WITH_CONTEXT, "utf8");
    await writeFile(p2, TRANSCRIPT_NO_CONTEXT, "utf8");

    await recordFromTranscript(root, p1, "with");
    await recordFromTranscript(root, p2, "without");

    const report = await aggregate(root);
    assert.equal(report.totalSessions, 2);
    assert.equal(report.withContext.sessions, 1);
    assert.equal(report.withoutContext.sessions, 1);
    // with-context averaged input/turn = 2700/2 = 1350; without = 5000/1 = 5000.
    assert.equal(report.withContext.avgInputPerTurn, 1350);
    assert.equal(report.withoutContext.avgInputPerTurn, 5000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recordFromTranscript is fail-safe on a missing transcript and empty sessions", async () => {
  const root = await tmp();
  try {
    const res = await recordFromTranscript(root, path.join(root, "nope.jsonl"), "x");
    assert.equal(res, null);
    const report = await aggregate(root);
    assert.equal(report.totalSessions, 0);
    assert.match(report.note, /No sessions recorded/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const claude = (id, usage = {}, content = []) => JSON.stringify({ type: "assistant", message: { id, role: "assistant", usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 50, ...usage }, content } });
const completeOptions = { childAccounting: "complete", childTranscripts: [] };

test("Claude categories are disjoint and missing counters remain unavailable", () => {
  const complete = summarizeTranscript(claude("m1"), "s");
  assert.equal(complete.accounting.totalTokens, 200);
  assert.equal(complete.accounting.cacheWriteTokens, 30);
  assert.equal(complete.scope.status, "parent-only");
  const partial = summarizeTranscript(JSON.stringify({ message: { id: "m", usage: { input_tokens: 100, output_tokens: 20 } } }), "s");
  assert.equal(partial.accounting.cacheReadTokens, null);
  assert.equal(partial.accounting.availability.cacheRead, "unavailable");
  assert.equal(partial.accounting.totalTokens, null);
  assert.equal(partial.accounting.complete, false);
});

test("logical snapshots retain final usage and merge previously reported input without double counting", () => {
  const sample = summarizeTranscript([
    claude("m1", { output_tokens: 0 }),
    JSON.stringify({ message: { id: "m1", usage: { output_tokens: 45 } } }),
    JSON.stringify({ message: { id: "m1", content: [{ type: "text", text: "done" }] } }),
  ].join("\n"), "s");
  assert.equal(sample.turns, 1);
  assert.equal(sample.inputTokens, 100);
  assert.equal(sample.outputTokens, 45);
  assert.equal(sample.accounting.totalTokens, 225);
  const missing = summarizeTranscript([claude("measured"), JSON.stringify({ type: "assistant", message: { id: "unmeasured", role: "assistant", content: [{ type: "text", text: "usage unknown" }] } })].join("\n"), "s");
  assert.equal(missing.accounting.complete, false);
  assert.equal(missing.accounting.totalTokens, null);
  assert.match(missing.accounting.issues.join(" "), /lack measured usage/);
});

test("Codex cumulative counters use the latest snapshot and subtract cached input once", () => {
  const codex = (input, cached, output) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: { input_tokens: 50 } } } });
  const sample = summarizeTranscript([JSON.stringify({ item: { id: "answer", type: "agent_message", text: "done" } }), codex(1000, 200, 30), codex(1500, 400, 60), codex(1500, 400, 60)].join("\n"), "s");
  assert.equal(sample.inputTokens, 1100);
  assert.equal(sample.cacheReadTokens, 400);
  assert.equal(sample.accounting.cacheWriteTokens, 0);
  assert.equal(sample.accounting.availability.cacheWrite, "not-applicable");
  assert.equal(sample.accounting.totalTokens, 1560);
  assert.equal(sample.turnCountAvailable, false);
  const reset = summarizeTranscript([codex(1000, 200, 30), codex(200, 100, 10)].join("\n"), "s");
  assert.equal(reset.accounting.complete, false);
  assert.equal(reset.accounting.totalTokens, null);
});

test("OpenAI inclusive input normalization and incomplete/unsupported schemas fail closed", () => {
  const sample = summarizeTranscript(JSON.stringify({ response: { id: "r", usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 300 }, output_tokens: 40 } } }), "s");
  assert.equal(sample.inputTokens, 600);
  assert.equal(sample.accounting.totalTokens, 940);
  for (const usage of [
    { input_tokens: 10, input_tokens_details: { cached_tokens: 20 }, output_tokens: 1 },
    { input_tokens: 10, input_tokens_details: {}, output_tokens: 1 },
    { input_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens: 1, cache_creation_input_tokens: 4 },
  ]) assert.equal(summarizeTranscript(JSON.stringify({ response: { id: "r", usage } }), "s").accounting.complete, false);
  assert.equal(summarizeTranscript(JSON.stringify({ id: "r", usage: { input_tokens: 10, output_tokens: 1 } }), "s").accounting.complete, false);
});

test("context tools recognize current and legacy structured names without substring or prose matches", () => {
  for (const name of ["get_context", "get_engineering_context", "mcp__graphward__get_context", "mcp__graphward__get_engineering_context"]) {
    assert.equal(summarizeTranscript(claude("m", {}, [{ type: "tool_use", name }]), "s").contextUsed, true);
  }
  assert.equal(summarizeTranscript(claude("m", {}, [{ type: "tool_use", name: "fake_get_context" }, { type: "text", text: "get_engineering_context" }]), "s").contextUsed, false);
  assert.equal(summarizeTranscript(JSON.stringify({ item: { type: "mcp_tool_call", server: "graphward", tool: "get_engineering_context" } }), "s").contextUsed, true);
});

test("invalid counters, decreased snapshots and aggregate overflow cannot become complete evidence", () => {
  for (const input_tokens of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "100"]) {
    assert.equal(summarizeTranscript(claude("m", { input_tokens }), "s").accounting.complete, false);
  }
  const decreased = summarizeTranscript([claude("m"), claude("m", { input_tokens: 50 })].join("\n"), "s");
  assert.equal(decreased.accounting.totalTokens, null);
  const changed = summarizeTranscript([claude("m"), claude("m", { input_tokens: 150 })].join("\n"), "s");
  assert.equal(changed.accounting.totalTokens, null);
  assert.equal(summarizeTranscript(claude("m", { total_tokens: 999 }), "s").accounting.complete, false);
  const overflow = summarizeTranscript([claude("a", { input_tokens: Number.MAX_SAFE_INTEGER }), claude("b")].join("\n"), "s");
  assert.equal(overflow.accounting.totalTokens, null);
  assert.equal(overflow.accounting.availability.uncachedInput, "unavailable");
  assert.match(overflow.accounting.issues.join(" "), /safe integer/);
});

test("recording is idempotent, concurrent sessions retain both rows, and legacy duplicates aggregate once", async () => {
  const root = await tmp();
  try {
    const file = path.join(root, "parent.jsonl");
    await writeFile(file, claude("m"));
    await Promise.all([recordFromTranscript(root, file, "one", completeOptions), recordFromTranscript(root, file, "two", completeOptions)]);
    await recordFromTranscript(root, file, "one", completeOptions);
    assert.equal((await aggregate(root)).totalSessions, 2);
    const log = path.join(root, ".graphward/telemetry/sessions.jsonl");
    const raw = await readFile(log, "utf8");
    await writeFile(log, raw + raw);
    const report = await aggregate(root);
    assert.equal(report.totalSessions, 2);
    assert.equal(report.withoutContext.completeSessions, 2);
    assert.match(renderReport(report), /Observational, unmatched cohorts/);
    await writeFile(file, claude("m", { input_tokens: 1 }));
    const reset = await recordFromTranscript(root, file, "one", completeOptions);
    assert.equal(reset.accounting.complete, false);
    const repeatReset = await recordFromTranscript(root, file, "one", completeOptions);
    assert.equal(repeatReset.accounting.complete, false);
    assert.equal(repeatReset.accounting.totalTokens, null);
    assert.equal(repeatReset.accounting.conflicted, true);
    assert.equal((await aggregate(root)).withoutContext.completeSessions, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only explicitly authorized child links are read, deduplicated by session/path and logical message", async () => {
  const root = await tmp();
  try {
    const parent = path.join(root, "parent.jsonl"), child = path.join(root, "child.jsonl");
    await writeFile(parent, claude("shared"));
    await writeFile(child, [claude("shared"), claude("child", {}, [{ type: "tool_use", name: "get_engineering_context" }])].join("\n"));
    const parentOnly = await recordFromTranscript(root, parent, "p");
    assert.equal(parentOnly.inputTokens, 100);
    assert.equal(parentOnly.scope.status, "parent-only");
    const link = { sessionId: "c", parentSessionId: "p", transcriptPath: child };
    const complete = await recordFromTranscript(root, parent, "p", { childAccounting: "complete", transcriptRoot: root, childTranscripts: [link, link] });
    assert.equal(complete.turns, 2);
    assert.equal(complete.accounting.totalTokens, 400);
    assert.equal(complete.scope.status, "complete");
    assert.equal(complete.scope.transcripts, 2);
    assert.equal(complete.contextUsed, true);
    const cycle = await recordFromTranscript(root, parent, "p", { childAccounting: "complete", childTranscripts: [link, { sessionId: "p", parentSessionId: "c", transcriptPath: parent }] });
    assert.equal(cycle.scope.status, "incomplete");
    assert.match(cycle.scope.issues.join(" "), /cycle/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("child path escapes, symlink escapes, missing links and conflicting identities remain incomplete", async () => {
  const root = await tmp(), outside = await tmp();
  try {
    const parent = path.join(root, "parent.jsonl"), secret = path.join(outside, "outside.jsonl");
    await writeFile(parent, claude("parent")); await writeFile(secret, claude("outside", { input_tokens: 99999 }));
    const alias = path.join(root, "alias.jsonl"); await symlink(secret, alias);
    for (const transcriptPath of [secret, alias, "missing.jsonl"]) {
      const sample = await recordFromTranscript(root, parent, "p", { childAccounting: "complete", childTranscripts: [{ sessionId: "c", parentSessionId: "p", transcriptPath }] });
      assert.equal(sample.inputTokens, 100);
      assert.equal(sample.scope.status, "incomplete");
    }
    const unlinked = await recordFromTranscript(root, parent, "p", { childAccounting: "complete", childTranscripts: [{ sessionId: "c", parentSessionId: "unknown", transcriptPath: secret }] });
    assert.match(unlinked.scope.issues.join(" "), /unlinked/);
    const duplicatePath = await recordFromTranscript(root, parent, "p", { childAccounting: "complete", childTranscripts: [{ sessionId: "different", parentSessionId: "p", transcriptPath: parent }] });
    assert.match(duplicatePath.scope.issues.join(" "), /duplicate path/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("known-empty children require an explicit manifest and supplied children need supported usage", async () => {
  const root = await tmp();
  try {
    const parent = path.join(root, "parent.jsonl"), child = path.join(root, "child.jsonl");
    await writeFile(parent, claude("p")); await writeFile(child, JSON.stringify({ type: "user", message: { content: "child has no measured usage" } }));
    const unattested = await recordFromTranscript(root, parent, "p", { childAccounting: "complete" });
    assert.equal(unattested.scope.status, "parent-only");
    const missingUsage = await recordFromTranscript(root, parent, "p", { childAccounting: "complete", childTranscripts: [{ sessionId: "c", parentSessionId: "p", transcriptPath: child }] });
    assert.equal(missingUsage.accounting.complete, false);
    assert.equal(missingUsage.accounting.totalTokens, null);
    assert.match(missingUsage.accounting.issues.join(" "), /child transcript lacks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
