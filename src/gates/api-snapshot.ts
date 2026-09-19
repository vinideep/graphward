import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GateOptions, GateResult } from "./index.js";

export interface ApiSnapshotExchange {
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; headers?: Record<string, string>; body?: unknown };
}

export interface ApiSnapshotManifest {
  schemaVersion: 1;
  unit: string;
  capturedAt: string;
  volatilePaths: string[];
  sensitivePaths: string[];
  sourceFiles: string[];
  exchange: ApiSnapshotExchange;
}

export interface ApiSnapshotReplayReport {
  schemaVersion: 1;
  unit: string;
  replayedAt: string;
  status: "pass" | "fail";
  differences: string[];
}

const SECRET_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key)$/i;
const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|access[-_]?key|refresh[-_]?token|session)/i;

function setAtPath(value: unknown, dotted: string, replacement: unknown): void {
  if (!value || typeof value !== "object") return;
  const parts = dotted.split(".").filter(Boolean);
  let current = value as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = current[parts[i]];
    if (!next || typeof next !== "object") return;
    current = next as Record<string, unknown>;
  }
  if (parts.length && Object.prototype.hasOwnProperty.call(current, parts.at(-1)!)) current[parts.at(-1)!] = replacement;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item);
  }
  return out;
}

function normalizeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), SECRET_HEADER.test(key) ? "[REDACTED]" : value] as const)
    .sort(([a], [b]) => a.localeCompare(b)));
}

export function normalizeApiExchange(
  exchange: ApiSnapshotExchange,
  options: { volatilePaths?: string[]; sensitivePaths?: string[] } = {},
): ApiSnapshotExchange {
  const copy = structuredClone(exchange);
  copy.request.headers = normalizeHeaders(copy.request.headers);
  copy.response.headers = normalizeHeaders(copy.response.headers);
  copy.request.body = redact(copy.request.body);
  copy.response.body = redact(copy.response.body);
  for (const sensitive of options.sensitivePaths ?? []) setAtPath(copy, sensitive, "[REDACTED]");
  for (const volatile of options.volatilePaths ?? []) setAtPath(copy, volatile, "[VOLATILE]");
  return copy;
}

function snapshotDir(root: string, unit: string): string {
  const safe = unit.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(root, ".graphward", "snapshots", safe);
}

export async function captureApiSnapshot(
  root: string,
  unit: string,
  exchange: ApiSnapshotExchange,
  options: { volatilePaths?: string[]; sensitivePaths?: string[]; sourceFiles?: string[] } = {},
): Promise<{ path: string; manifest: ApiSnapshotManifest }> {
  if (!options.sourceFiles?.length) throw new Error("API snapshot capture requires at least one response-producing source file for gate coverage.");
  const dir = snapshotDir(root, unit);
  await mkdir(dir, { recursive: true });
  const manifest: ApiSnapshotManifest = {
    schemaVersion: 1,
    unit,
    capturedAt: new Date().toISOString(),
    volatilePaths: options.volatilePaths ?? [],
    sensitivePaths: options.sensitivePaths ?? [],
    sourceFiles: [...new Set(options.sourceFiles ?? [])].sort(),
    exchange: normalizeApiExchange(exchange, options),
  };
  const target = path.join(dir, "manifest.json");
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { path: path.relative(root, target).replace(/\\/g, "/"), manifest };
}

function diffValues(expected: unknown, actual: unknown, at = "$", out: string[] = []): string[] {
  if (Object.is(expected, actual)) return out;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.push(`${at}.length: expected ${expected.length}, got ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) diffValues(expected[i], actual[i], `${at}[${i}]`, out);
    return out;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) diffValues((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${at}.${key}`, out);
    return out;
  }
  out.push(`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return out;
}

export async function replayApiSnapshot(root: string, unit: string, actual: ApiSnapshotExchange): Promise<ApiSnapshotReplayReport> {
  const dir = snapshotDir(root, unit);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as ApiSnapshotManifest;
  const normalized = normalizeApiExchange(actual, { volatilePaths: manifest.volatilePaths, sensitivePaths: manifest.sensitivePaths });
  const differences = diffValues(manifest.exchange, normalized);
  const report: ApiSnapshotReplayReport = { schemaVersion: 1, unit, replayedAt: new Date().toISOString(), status: differences.length ? "fail" : "pass", differences };
  await writeFile(path.join(dir, "replay-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function apiFiles(files: string[]): string[] {
  return files.filter((file) =>
    /(^|\/)(routes?|controllers?|handlers?)(\/|\.|-)/i.test(file) ||
    /(^|\/)api(\/|\.[cm]?[jt]sx?$)/i.test(file) ||
    /(^|\/)(openapi|swagger)(\/|\.)/i.test(file),
  );
}

export async function apiSnapshotGate(root: string, options: GateOptions = {}): Promise<GateResult> {
  const affected = apiFiles(options.changedFiles ?? []);
  if (!affected.length) return { gate: "api-snapshot", status: "skipped", summary: "No response-producing surface changed.", findings: [], applicable: false, required: false, reason: "no API response surface in changed files" };
  const snapshots = path.join(root, ".graphward", "snapshots");
  if (!existsSync(snapshots)) return { gate: "api-snapshot", status: "unavailable", summary: "API response changed but no snapshot baseline exists.", findings: [{ severity: "error", message: `Capture and replay snapshots for: ${affected.join(", ")}` }], applicable: true, required: true };
  const { readdir } = await import("node:fs/promises");
  const units = await readdir(snapshots, { withFileTypes: true });
  const reports: Array<{ report: ApiSnapshotReplayReport; manifest: ApiSnapshotManifest }> = [];
  for (const unit of units.filter((entry) => entry.isDirectory())) {
    const reportPath = path.join(snapshots, unit.name, "replay-report.json");
    const manifestPath = path.join(snapshots, unit.name, "manifest.json");
    if (existsSync(reportPath) && existsSync(manifestPath)) reports.push({
      report: JSON.parse(await readFile(reportPath, "utf8")) as ApiSnapshotReplayReport,
      manifest: JSON.parse(await readFile(manifestPath, "utf8")) as ApiSnapshotManifest,
    });
  }
  if (!reports.length) return { gate: "api-snapshot", status: "unavailable", summary: "API snapshot replay evidence is missing.", findings: [{ severity: "error", message: "Run `gw snapshot replay` after integration tests." }], applicable: true, required: true };
  const uncovered = affected.filter((file) => !reports.some(({ manifest }) => manifest.sourceFiles?.includes(file)));
  if (uncovered.length) return { gate: "api-snapshot", status: "unavailable", summary: "API replay evidence does not cover every changed response surface.", findings: uncovered.map((file) => ({ severity: "error" as const, file, message: "No passing snapshot unit declares this changed file in sourceFiles." })), applicable: true, required: true, artifact: ".graphward/snapshots/*/manifest.json" };
  const failed = reports.filter(({ report, manifest }) => report.status === "fail" && manifest.sourceFiles.some((file) => affected.includes(file)));
  return { gate: "api-snapshot", status: failed.length ? "fail" : "pass", summary: failed.length ? `${failed.length} covered API snapshot replay(s) differ.` : `${affected.length} changed API surface(s) have passing replay evidence.`, findings: failed.flatMap(({ report }) => report.differences.map((message) => ({ severity: "error" as const, message: `${report.unit}: ${message}` }))), applicable: true, required: true, artifact: ".graphward/snapshots/*/replay-report.json" };
}
