import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphNode } from "../schema.js";
import { readApprovedSource } from "../../project-files/index.js";

export interface ManifestResult {
  nodes: GraphNode[];
  devNodeIds: Set<string>;
}

function pkgNode(name: string, manifestPath: string, dev: boolean): GraphNode {
  return {
    id: `pkg:${name}`,
    kind: "package",
    label: name,
    confidence: "verified",
    metadata: { dev, declared: true },
    evidence: [manifestPath],
  };
}

async function tryRead(filePath: string, root: string): Promise<string | null> {
  try {
    return (await readApprovedSource(root, filePath)).content;
  } catch {
    return null;
  }
}

async function parsePackageJson(root: string): Promise<ManifestResult> {
  const manifestPath = path.join(root, "package.json");
  const content = await tryRead(manifestPath, root);
  if (!content) return { nodes: [], devNodeIds: new Set() };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { nodes: [], devNodeIds: new Set() };
  }
  const relPath = "package.json";
  const nodes: GraphNode[] = [];
  const devNodeIds = new Set<string>();
  const deps = parsed.dependencies;
  if (deps && typeof deps === "object" && !Array.isArray(deps)) {
    for (const name of Object.keys(deps)) {
      nodes.push(pkgNode(name, relPath, false));
    }
  }
  const devDeps = parsed.devDependencies;
  if (devDeps && typeof devDeps === "object" && !Array.isArray(devDeps)) {
    for (const name of Object.keys(devDeps)) {
      const id = `pkg:${name}`;
      devNodeIds.add(id);
      if (!nodes.find((n) => n.id === id)) {
        nodes.push(pkgNode(name, relPath, true));
      }
    }
  }
  const peerDeps = parsed.peerDependencies;
  if (peerDeps && typeof peerDeps === "object" && !Array.isArray(peerDeps)) {
    for (const name of Object.keys(peerDeps)) {
      const id = `pkg:${name}`;
      if (!nodes.find((n) => n.id === id)) {
        nodes.push(pkgNode(name, relPath, false));
      }
    }
  }
  return { nodes, devNodeIds };
}

interface TomlString { start: number; end: number; value: string }

/** Keep offsets while making comments and string contents inert. This only
 * consumes PEP 621's string-array field, not general TOML configuration. */
function tomlStructure(content: string): { masked: string; strings: TomlString[] } {
  const masked = content.split("");
  const strings: TomlString[] = [];
  const blank = (start: number, end: number) => { for (let at = start; at < end; at++) if (masked[at] !== "\n" && masked[at] !== "\r") masked[at] = " "; };
  for (let index = 0; index < content.length;) {
    if (content[index] === "#") {
      const end = content.indexOf("\n", index);
      blank(index, end < 0 ? content.length : end); index = end < 0 ? content.length : end; continue;
    }
    const quote = content[index];
    if (quote !== '"' && quote !== "'") { index++; continue; }
    const start = index;
    const delimiter = content.slice(index, index + 3) === quote.repeat(3) ? quote.repeat(3) : quote;
    index += delimiter.length;
    const valueStart = index;
    let valueEnd = -1;
    while (index < content.length) {
      if (quote === '"' && content[index] === "\\") { index += 2; continue; }
      if (content.startsWith(delimiter, index)) { valueEnd = index; index += delimiter.length; break; }
      index++;
    }
    blank(start, index);
    if (valueEnd < 0) continue;
    let value = content.slice(valueStart, valueEnd);
    if (quote === '"') {
      value = value.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(["\\btnfr]))/g, (raw, short, long, simple) => {
        if (short || long) { const code = Number.parseInt(short ?? long, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : raw; }
        return ({ '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" } as Record<string, string>)[simple] ?? raw;
      });
    }
    strings.push({ start, end: index, value });
  }
  return { masked: masked.join(""), strings };
}

function pep621Dependencies(content: string): string[] {
  const { masked, strings } = tomlStructure(content);
  const headers = [...masked.matchAll(/^[ \t]*(\[\[?)([^\]\r\n]+)\]\]?[ \t]*\r?$/gm)];
  const project = headers.find(header => header[1] === "[" && header[2].trim() === "project");
  if (!project) return [];
  const start = project.index! + project[0].length;
  const end = headers.find(header => header.index! > project.index!)?.index ?? masked.length;
  const assignment = /^[ \t]*dependencies[ \t]*=[ \t]*\[/gm;
  assignment.lastIndex = start;
  const match = assignment.exec(masked);
  if (!match || match.index >= end) return [];
  const opening = match.index + match[0].lastIndexOf("[");
  let depth = 1;
  let closing = opening + 1;
  while (closing < end && depth) {
    if (masked[closing] === "[") depth++;
    else if (masked[closing] === "]") depth--;
    if (depth) closing++;
  }
  if (depth || /[^\s,]/.test(masked.slice(opening + 1, closing))) return [];
  return strings.filter(item => item.start > opening && item.end <= closing).map(item => item.value);
}

async function parsePyproject(root: string): Promise<ManifestResult> {
  const manifestPath = path.join(root, "pyproject.toml");
  const content = await tryRead(manifestPath, root);
  if (!content) return { nodes: [], devNodeIds: new Set() };
  const relPath = "pyproject.toml";
  const nodes: GraphNode[] = [];
  // PEP 621 declares a string array under [project], rather than a
  // [project.dependencies] table. Keep quoted extras/markers inside strings.
  for (const requirement of pep621Dependencies(content)) {
    const name = requirement.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
    if (name) { const node = pkgNode(name, relPath, false); node.metadata.specifier = requirement; node.metadata.manifestFormat = "PEP621"; nodes.push(node); }
  }
  return { nodes, devNodeIds: new Set() };
}

async function parseRequirementsTxt(root: string): Promise<ManifestResult> {
  const manifestPath = path.join(root, "requirements.txt");
  const content = await tryRead(manifestPath, root);
  if (!content) return { nodes: [], devNodeIds: new Set() };
  const relPath = "requirements.txt";
  const nodes: GraphNode[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const name = trimmed.split(/[>=<!~\[;]/)[0].trim();
    if (name) nodes.push(pkgNode(name, relPath, false));
  }
  return { nodes, devNodeIds: new Set() };
}

async function parseGoMod(root: string): Promise<ManifestResult> {
  const manifestPath = path.join(root, "go.mod");
  const content = await tryRead(manifestPath, root);
  if (!content) return { nodes: [], devNodeIds: new Set() };
  const relPath = "go.mod";
  const nodes: GraphNode[] = [];
  const inRequire = { value: false };
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "require (") { inRequire.value = true; continue; }
    if (trimmed === ")") { inRequire.value = false; continue; }
    if (trimmed.startsWith("require ") || inRequire.value) {
      const match = trimmed.match(/^(?:require\s+)?([\w.\-/]+)\s+v[\d.]/);
      if (match) nodes.push(pkgNode(match[1], relPath, false));
    }
  }
  return { nodes, devNodeIds: new Set() };
}

async function parseCargoToml(root: string): Promise<ManifestResult> {
  const manifestPath = path.join(root, "Cargo.toml");
  const content = await tryRead(manifestPath, root);
  if (!content) return { nodes: [], devNodeIds: new Set() };
  const relPath = "Cargo.toml";
  const nodes: GraphNode[] = [];
  let inDeps = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "[dependencies]") { inDeps = true; continue; }
    if (trimmed.startsWith("[") && trimmed !== "[dependencies]") { inDeps = false; continue; }
    if (inDeps) {
      const match = trimmed.match(/^([\w-]+)\s*=/);
      if (match) nodes.push(pkgNode(match[1], relPath, false));
    }
  }
  return { nodes, devNodeIds: new Set() };
}

export async function parseManifests(root: string): Promise<ManifestResult> {
  const results = await Promise.all([
    parsePackageJson(root),
    parsePyproject(root),
    parseRequirementsTxt(root),
    parseGoMod(root),
    parseCargoToml(root),
  ]);
  const nodes: GraphNode[] = [];
  const devNodeIds = new Set<string>();
  const seen = new Set<string>();
  for (const result of results) {
    for (const id of result.devNodeIds) devNodeIds.add(id);
    for (const node of result.nodes) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        nodes.push(node);
      }
    }
  }
  return { nodes, devNodeIds };
}
