/** Observed host usage only. Missing accounting is unavailable, never zero evidence. */
import { readFile, writeFile, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withLock } from "../manifest/lock.js";

export type TranscriptHost = "claude" | "codex" | "openai" | "unsupported";
export type TokenAvailability = "reported" | "not-applicable" | "unavailable";
type Category = "uncachedInput" | "cacheWrite" | "cacheRead" | "output";
const CATEGORIES: Category[] = ["uncachedInput", "cacheWrite", "cacheRead", "output"];

export interface TokenAccounting {
  uncachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  availability: Record<Category, TokenAvailability>;
  complete: boolean;
  /** Counter conflicts persist across observations of the same session identity. */
  conflicted?: boolean;
  hosts: TranscriptHost[];
  issues: string[];
}
export interface TranscriptScope {
  status: "complete" | "parent-only" | "incomplete";
  transcripts: number;
  issues: string[];
}
export interface SessionSample {
  sessionId: string;
  recordedAt: string;
  /** Compatibility count of usage records; cumulative session totals are not turns. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextUsed: boolean;
  cacheWriteTokens?: number;
  accounting?: TokenAccounting;
  scope?: TranscriptScope;
  turnCountAvailable?: boolean;
}
export interface TranscriptOptions {
  host?: TranscriptHost;
  /** Caller attestation, including an explicit empty list for a known child-free session. */
  childAccounting?: "complete" | "unavailable";
  transcriptRoot?: string;
  /** Explicit authorization and parent links; never discovered by scanning directories. */
  childTranscripts?: Array<{ sessionId: string; parentSessionId: string; transcriptPath: string }>;
}
const DIR = ".graphward/telemetry";
const LOG = `${DIR}/sessions.jsonl`;
type ObjectValue = Record<string, unknown>;
interface UsageRecord {
  host: TranscriptHost;
  cumulative: boolean;
  input: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  output: number | null;
  invalid: boolean;
}
interface ParsedTranscript {
  records: Map<string, UsageRecord>;
  contextUsed: boolean;
  issues: string[];
  turnCountAvailable: boolean;
}
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function contextTool(name: unknown): boolean {
  return typeof name === "string" && /^(?:mcp__graphward__)?(?:get_context|get_engineering_context)$/.test(name);
}
function hasContextTool(value: ObjectValue): boolean {
  if (Array.isArray(value.content) && value.content.some(item => {
    const tool = object(item);
    return tool && ["tool_use", "function_call"].includes(String(tool.type)) && contextTool(tool.name);
  })) return true;
  if (["tool_use", "function_call"].includes(String(value.type)) && contextTool(value.name)) return true;
  if (value.type === "mcp_tool_call" && value.server === "graphward" && contextTool(value.tool)) return true;
  const parameters = object(object(value.tool_info)?.parameters);
  return parameters?.ServerName === "graphward" && contextTool(parameters.ToolName);
}
function readUsage(usage: ObjectValue, host: TranscriptHost, cumulative: boolean): UsageRecord {
  const details = object(usage.input_tokens_details) ?? object(usage.prompt_tokens_details);
  const values = {
    input: usage.input_tokens ?? usage.prompt_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? details?.cached_tokens,
    output: usage.output_tokens ?? usage.completion_tokens,
  };
  const input = counter(values.input), output = counter(values.output);
  const components = host === "claude" ? [input, output, counter(values.cacheWrite), counter(values.cacheRead)] : [input, output];
  const reportedTotal = usage.total_tokens;
  const totalMismatch = reportedTotal !== undefined && (counter(reportedTotal) === null || components.every(value => value !== null) && components.reduce<number>((sum, value) => sum + value!, 0) !== reportedTotal);
  return {
    host, cumulative, input, cacheWrite: counter(values.cacheWrite),
    cacheRead: counter(values.cacheRead), output: counter(values.output),
    invalid: Object.values(values).some(value => value !== undefined && counter(value) === null) || totalMismatch ||
      ((host === "codex" || host === "openai") && counter(values.cacheWrite) !== null && counter(values.cacheWrite)! > 0),
  };
}
function mergeUsage(previous: UsageRecord | undefined, current: UsageRecord): UsageRecord {
  if (!previous) return current;
  const decreased = (["input", "cacheWrite", "cacheRead", "output"] as const)
    .some(key => previous[key] !== null && current[key] !== null && current[key] < previous[key]);
  const changedFixedInput = !current.cumulative && (["input", "cacheWrite", "cacheRead"] as const)
    .some(key => previous[key] !== null && current[key] !== null && previous[key] !== 0 && current[key] !== 0 && current[key] !== previous[key]);
  return {
    host: current.host, cumulative: current.cumulative, input: current.input ?? previous.input,
    cacheWrite: current.cacheWrite ?? previous.cacheWrite, cacheRead: current.cacheRead ?? previous.cacheRead,
    output: current.output ?? previous.output,
    invalid: previous.invalid || current.invalid || decreased || changedFixedInput || current.host !== previous.host,
  };
}
function parseTranscript(transcript: string, sessionId: string, selectedHost?: TranscriptHost): ParsedTranscript {
  const records = new Map<string, UsageRecord>(), issues: string[] = [];
  const assistantMessages = new Set<string>();
  let contextUsed = false, anonymous = 0, cumulative = false;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let value: ObjectValue | undefined;
    try { value = object(JSON.parse(line)); } catch { issues.push("Malformed transcript row."); continue; }
    if (!value) continue;
    const payload = object(value.payload), item = object(value.item);
    const message = object(value.message) ?? object(value.response) ?? item ?? value;
    const logicalId = message.id ?? value.message_id ?? value.response_id ?? value.turn_id;
    if (value.type === "assistant" || message.role === "assistant" || value.response !== undefined || item?.type === "agent_message") {
      const messageHost = selectedHost ?? (value.response !== undefined ? "openai" : item?.type === "agent_message" ? "codex" : value.message !== undefined ? "claude" : "unsupported");
      assistantMessages.add(typeof logicalId === "string" && logicalId ? `${messageHost}:${logicalId}` : `${messageHost}:unidentified-assistant`);
    }
    contextUsed ||= [value, message, payload, object(value.step_update)].some(part => part && hasContextTool(part));
    const total = payload?.type === "token_count" ? object(object(payload.info)?.total_token_usage) : undefined;
    const usage = total ?? object(message.usage);
    if (!usage) {
      if (payload?.type === "token_count" && object(object(payload.info)?.last_token_usage)) issues.push("Codex last-token usage lacks a cumulative session total.");
      continue;
    }
    const inferredHost: TranscriptHost = total || value.type === "turn.completed" || usage.cached_input_tokens !== undefined
      ? "codex" : usage.input_tokens_details !== undefined || usage.prompt_tokens !== undefined || value.response !== undefined
        ? "openai" : value.message !== undefined ? "claude" : "unsupported";
    const host = selectedHost ?? inferredHost;
    if (host === "unsupported") issues.push("Unsupported host usage semantics.");
    if (selectedHost && inferredHost !== "unsupported" && selectedHost !== inferredHost) issues.push("Selected host conflicts with the transcript schema.");
    if (total) cumulative = true;
    const id = total ? `cumulative:${sessionId}` : logicalId;
    const key = typeof id === "string" && id ? `${host}:${id}` : `anonymous:${sessionId}:${anonymous++}`;
    if (key.startsWith("anonymous:")) issues.push("Usage record lacks a stable logical identity for snapshot reconciliation.");
    records.set(key, mergeUsage(records.get(key), readUsage(usage, host, total !== undefined)));
  }
  if (cumulative) {
    // A Codex session total already includes its per-turn usage. Never add both.
    for (const [key, record] of records) if (record.host === "codex" && key !== `codex:cumulative:${sessionId}`) records.delete(key);
  }
  if ([...assistantMessages].some(key => !(cumulative && key.startsWith("codex:")) && !records.has(key))) issues.push("Assistant logical messages lack measured usage.");
  return { records, contextUsed, issues: [...new Set(issues)], turnCountAvailable: !cumulative };
}
function sampleFromParsed(parsed: ParsedTranscript, sessionId: string, scope: TranscriptScope): SessionSample {
  const sums: Record<Category, number> = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const available: Record<Category, number> = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const applicable: Record<Category, number> = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const overflow = new Set<Category>(), issues = [...parsed.issues];
  let conflicted = false;
  for (const record of parsed.records.values()) {
    const inclusive = record.host === "codex" || record.host === "openai";
    const invalidCache = inclusive && record.input !== null && record.cacheRead !== null && record.cacheRead > record.input;
    if (record.invalid || invalidCache) { issues.push("Invalid, decreased, or inconsistent token counters."); conflicted = true; }
    const values: Record<Category, number | null> = {
      uncachedInput: inclusive ? record.input !== null && record.cacheRead !== null && !invalidCache ? record.input - record.cacheRead : null : record.host === "claude" ? record.input : null,
      cacheWrite: inclusive ? 0 : record.host === "claude" ? record.cacheWrite : null,
      cacheRead: record.host === "unsupported" ? null : record.cacheRead,
      output: record.host === "unsupported" ? null : record.output,
    };
    for (const category of CATEGORIES) {
      const value = values[category];
      if (value !== null) {
        if (counter(sums[category] + value) === null) overflow.add(category);
        else sums[category] += value;
        available[category]++;
      }
      if (!(category === "cacheWrite" && inclusive)) applicable[category]++;
    }
  }
  if (overflow.size) { issues.push("Aggregated token counters exceed safe integer precision."); conflicted = true; }
  const count = parsed.records.size;
  const availability = Object.fromEntries(CATEGORIES.map(category => [category,
    count === 0 || available[category] !== count || overflow.has(category) ? "unavailable" : applicable[category] === 0 ? "not-applicable" : "reported",
  ])) as Record<Category, TokenAvailability>;
  const total = Object.values(sums).reduce((sum, value) => sum + value, 0);
  if (counter(total) === null) { issues.push("Total tokens exceed safe integer precision."); conflicted = true; }
  const complete = count > 0 && CATEGORIES.every(category => availability[category] !== "unavailable") && issues.length === 0;
  const value = (category: Category) => availability[category] === "unavailable" ? null : sums[category];
  return {
    sessionId, recordedAt: new Date().toISOString(), turns: count,
    inputTokens: sums.uncachedInput, outputTokens: sums.output, cacheReadTokens: sums.cacheRead, cacheWriteTokens: sums.cacheWrite,
    contextUsed: parsed.contextUsed, turnCountAvailable: parsed.turnCountAvailable,
    accounting: {
      uncachedInputTokens: value("uncachedInput"), cacheWriteTokens: value("cacheWrite"), cacheReadTokens: value("cacheRead"), outputTokens: value("output"),
      totalTokens: complete ? total : null, availability, complete, conflicted,
      hosts: [...new Set([...parsed.records.values()].map(record => record.host))], issues: [...new Set(issues)],
    }, scope,
  };
}
/** Parse only supplied text. Child completeness requires an explicit recording contract. */
export function summarizeTranscript(transcript: string, sessionId: string, options: Pick<TranscriptOptions, "host"> = {}): SessionSample {
  return sampleFromParsed(parseTranscript(transcript, sessionId, options.host), sessionId,
    { status: "parent-only", transcripts: 1, issues: ["Child transcript accounting was not supplied."] });
}
function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/** Read only supplied authorized transcript links, then atomically upsert one sample. */
export async function recordFromTranscript(root: string, transcriptPath: string, sessionId: string, options: TranscriptOptions = {}): Promise<SessionSample | null> {
  try {
    const primaryPath = await realpath(transcriptPath), transcript = await readFile(primaryPath, "utf8");
    const parsed = parseTranscript(transcript, sessionId, options.host), scopeIssues: string[] = [];
    if (parsed.records.size === 0) parsed.issues.push("Primary transcript lacks supported usage records.");
    const visitedIds = new Map([[sessionId, primaryPath]]), visitedPaths = new Map([[primaryPath, sessionId]]), active = new Set([sessionId]);
    const children = options.childTranscripts ?? [], boundary = await realpath(options.transcriptRoot ?? path.dirname(primaryPath));
    if (!contained(boundary, primaryPath)) scopeIssues.push("Primary transcript escapes the authorized root.");
    const visit = async (parentId: string): Promise<void> => {
      for (const child of children.filter(entry => entry.parentSessionId === parentId)) {
        if (!child.sessionId || active.has(child.sessionId)) { scopeIssues.push("Child transcript cycle or missing identity."); continue; }
        let childPath: string;
        try { childPath = await realpath(path.resolve(boundary, child.transcriptPath)); } catch { scopeIssues.push("Authorized child transcript is unavailable."); continue; }
        if (!contained(boundary, childPath)) { scopeIssues.push("Child transcript escapes the authorized root."); continue; }
        const previousPath = visitedIds.get(child.sessionId), previousId = visitedPaths.get(childPath);
        if (previousPath || previousId) {
          if (previousPath !== childPath || previousId !== child.sessionId) scopeIssues.push("Conflicting child transcript identity or duplicate path.");
          continue;
        }
        let childParsed: ParsedTranscript;
        try { childParsed = parseTranscript(await readFile(childPath, "utf8"), child.sessionId, options.host); } catch { scopeIssues.push("Authorized child transcript is unreadable."); continue; }
        if (childParsed.records.size === 0) childParsed.issues.push("Authorized child transcript lacks supported usage records.");
        visitedIds.set(child.sessionId, childPath); visitedPaths.set(childPath, child.sessionId); active.add(child.sessionId);
        for (const [key, record] of childParsed.records) parsed.records.set(key, mergeUsage(parsed.records.get(key), record));
        parsed.contextUsed ||= childParsed.contextUsed; parsed.turnCountAvailable &&= childParsed.turnCountAvailable;
        parsed.issues.push(...childParsed.issues);
        await visit(child.sessionId); active.delete(child.sessionId);
      }
    };
    await visit(sessionId);
    if (children.some(child => !visitedIds.has(child.parentSessionId))) scopeIssues.push("Child transcript has an unlinked parent.");
    if (options.childTranscripts === undefined) scopeIssues.push("Explicit child transcript manifest was not supplied.");
    if (options.childAccounting !== "complete") scopeIssues.push("Child transcript accounting is unavailable.");
    const scope: TranscriptScope = { status: scopeIssues.length ? children.length ? "incomplete" : "parent-only" : "complete", transcripts: visitedIds.size, issues: [...new Set(scopeIssues)] };
    const sample = sampleFromParsed(parsed, sessionId, scope);
    if (sample.turns === 0) return null;
    await mkdir(path.join(root, DIR), { recursive: true });
    return await withLock(root, async () => {
      await ensureGitignored(root);
      const samples = await readSamples(root);
      const previous = samples.get(sessionId);
      const decreased = previous && ["inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens"].some(key => {
        const field = key as "inputTokens" | "cacheWriteTokens" | "cacheReadTokens" | "outputTokens";
        return sample[field] !== undefined && previous[field] !== undefined && sample[field]! < previous[field]!;
      });
      if (previous?.accounting?.conflicted || decreased) {
        sample.accounting!.complete = false;
        sample.accounting!.totalTokens = null;
        sample.accounting!.conflicted = true;
        sample.accounting!.issues.push(decreased ? "Session counters decreased between recordings." : "Earlier session counter conflicts remain unresolved.");
      }
      samples.set(sessionId, sample);
      const temporary = path.join(root, DIR, `sessions-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, [...samples.values()].map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
        await rename(temporary, path.join(root, LOG));
      } finally { await unlink(temporary).catch(() => undefined); }
      return sample;
    }, { name: "telemetry.lock", timeoutMs: 1000, retryIntervalMs: 20 });
  } catch { return null; } // Stop-hook telemetry is best-effort, including write/lock failures.
}
async function ensureGitignored(root: string): Promise<void> {
  const p = path.join(root, ".graphward", ".gitignore");
  let existing = "";
  try { existing = await readFile(p, "utf8"); } catch { /* new */ }
  if (!existing.includes("telemetry/")) await writeFile(p, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + "telemetry/\n", "utf8");
}
async function readSamples(root: string): Promise<Map<string, SessionSample>> {
  let raw = "";
  try { raw = await readFile(path.join(root, LOG), "utf8"); } catch { /* none yet */ }
  const samples = new Map<string, SessionSample>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const sample = JSON.parse(line) as SessionSample;
      if (typeof sample.sessionId === "string" && typeof sample.contextUsed === "boolean" && [sample.turns, sample.inputTokens, sample.outputTokens, sample.cacheReadTokens].every(value => counter(value) !== null)) samples.set(sample.sessionId, sample);
    } catch { /* ignore malformed rows */ }
  }
  return samples;
}
export interface Cohort {
  sessions: number;
  avgInputPerTurn: number;
  avgOutputPerSession: number;
  avgTurns: number;
  completeSessions?: number;
  avgTotalTokensPerCompleteSession?: number | null;
}
export interface TelemetryReport {
  totalSessions: number;
  withContext: Cohort;
  withoutContext: Cohort;
  note: string;
}
function cohort(samples: SessionSample[]): Cohort {
  const turns = samples.reduce((sum, sample) => sum + sample.turns, 0);
  const complete = samples.filter(sample => sample.accounting?.complete && sample.scope?.status === "complete" && counter(sample.accounting.totalTokens) !== null);
  return {
    sessions: samples.length,
    avgInputPerTurn: turns ? Math.round(samples.reduce((sum, sample) => sum + sample.inputTokens / turns, 0)) : 0,
    avgOutputPerSession: samples.length ? Math.round(samples.reduce((sum, sample) => sum + sample.outputTokens / samples.length, 0)) : 0,
    avgTurns: samples.length ? Math.round(turns / samples.length * 10) / 10 : 0,
    completeSessions: complete.length,
    avgTotalTokensPerCompleteSession: complete.length ? Math.round(complete.reduce((sum, sample) => sum + sample.accounting!.totalTokens! / complete.length, 0)) : null,
  };
}
export async function aggregate(root: string): Promise<TelemetryReport> {
  const samples = [...(await readSamples(root)).values()];
  return {
    totalSessions: samples.length,
    withContext: cohort(samples.filter(sample => sample.contextUsed)), withoutContext: cohort(samples.filter(sample => !sample.contextUsed)),
    note: samples.length === 0
      ? "No sessions recorded yet. Telemetry accumulates as the Stop hook observes supplied transcripts."
      : "Observational, unmatched cohorts; no causal efficiency or accuracy claim. Legacy/partial usage and unknown child accounting are incomplete. Known counters are descriptive; unavailable counters are not measured zeroes. Usage records may be cumulative snapshots rather than conversation turns.",
  };
}
export function renderReport(report: TelemetryReport): string {
  const lines = [`Token telemetry — ${report.totalSessions} session(s) observed.`, ""];
  const row = (label: string, c: Cohort) => `  ${label.padEnd(25)} sessions=${c.sessions}  complete=${c.completeSessions ?? 0}  knownUncached/record=${c.avgInputPerTurn}  knownOutput/session=${c.avgOutputPerSession}  total/completeSession=${c.avgTotalTokensPerCompleteSession ?? "unavailable"}`;
  lines.push(row("with context retrieval", report.withContext), row("without context retrieval", report.withoutContext), "", report.note);
  return lines.join("\n") + "\n";
}
