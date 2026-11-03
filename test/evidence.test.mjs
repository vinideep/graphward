/**
 * Evidence hashing tests (v2.3 self-invalidating knowledge).
 *
 * Proves that when a cited line of code changes, the knowledge-base citation
 * that pointed at it is mechanically flagged as stale.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordEvidenceHashes, checkEvidenceHashes } from "../dist/evidence/index.js";

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ei-evidence-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, ".graphward", "knowledge-base"), { recursive: true });
  writeFileSync(path.join(dir, "src", "auth.ts"), "export function login() {\n  return checkPassword();\n}\n");
  writeFileSync(
    path.join(dir, ".graphward", "knowledge-base", "auth.md"),
    "Login is handled at `src/auth.ts:2` which calls checkPassword.\n",
  );
  return dir;
}

test("evidence citation is ok immediately after recording", async () => {
  const dir = setup();
  try {
    await recordEvidenceHashes(dir);
    const report = await checkEvidenceHashes(dir);
    assert.equal(report.checked, 1);
    assert.equal(report.stale, 0);
    assert.equal(report.results[0].status, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("citation becomes stale when the cited line changes", async () => {
  const dir = setup();
  try {
    await recordEvidenceHashes(dir);
    // Change line 2 — the exact line the knowledge base cited.
    writeFileSync(path.join(dir, "src", "auth.ts"), "export function login() {\n  return verifyToken();\n}\n");
    const report = await checkEvidenceHashes(dir);
    assert.equal(report.stale, 1, `expected 1 stale, got: ${JSON.stringify(report)}`);
    assert.equal(report.results[0].status, "stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("citation is flagged when the cited file is removed", async () => {
  const dir = setup();
  try {
    await recordEvidenceHashes(dir);
    rmSync(path.join(dir, "src", "auth.ts"));
    const report = await checkEvidenceHashes(dir);
    assert.equal(report.results[0].status, "missing-file");
    assert.ok(report.stale >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("annotations, ranges, multispans, Source tables and path-only references share drift checks", async () => {
  const dir = setup();
  try {
    writeFileSync(path.join(dir, 'src/auth.ts'), 'one\ntwo\nthree\nfour\nfive\n');
    writeFileSync(path.join(dir, '.graphward/knowledge-base/auth.md'), '# Auth\n(evidence: src/auth.ts:L1-L3,5)\n| Source | `src/auth.ts:4` |\n');
    writeFileSync(path.join(dir, '.graphward/knowledge-base/path.md'), '# Auth source\n(evidence: src/auth.ts)\n');
    const snapshot = await recordEvidenceHashes(dir);
    assert.equal(snapshot.hashes.filter(item => item.file === 'src/auth.ts' && item.line > 0).length, 5);
    let report = await checkEvidenceHashes(dir);
    assert.ok(report.documents.every(item => item.verified), JSON.stringify(report.documents));
    writeFileSync(path.join(dir, 'src/auth.ts'), 'one\nchanged\nthree\nfour\nfive\n');
    report = await checkEvidenceHashes(dir);
    assert.ok(report.stale > 0);
    assert.equal(report.documents.filter(item => !item.verified).length, 2);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test("citation reads reject traversal and symlink escape, and malformed spans never verify", async () => {
  const dir = setup();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'ei-outside-'));
  try {
    const {symlinkSync} = await import('node:fs');
    writeFileSync(path.join(outside, 'secret.ts'), 'outside\n');
    symlinkSync(path.join(outside, 'secret.ts'), path.join(dir, 'src/link.ts'));
    writeFileSync(path.join(dir, '.graphward/knowledge-base/auth.md'), '(evidence: src/link.ts:1, ../outside.ts:1, src/auth.ts:9-2, src/auth.ts:1-999999999)\n');
    const snapshot = await recordEvidenceHashes(dir);
    assert.ok(snapshot.hashes.length < 100);
    assert.ok(!snapshot.sourceHashes?.['src/link.ts']);
    const report = await checkEvidenceHashes(dir);
    assert.ok(report.stale > 0);
    assert.equal(report.documents[0].verified, false);
  } finally { rmSync(dir, {recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
});

test("new citation syntax does not erase old stale hashes without recording", async () => {
  const dir = setup();
  try {
    await recordEvidenceHashes(dir);
    writeFileSync(path.join(dir, 'src/auth.ts'), 'export function login() {\n  return changed();\n}\n');
    writeFileSync(path.join(dir, '.graphward/knowledge-base/auth.md'), '(evidence: src/auth.ts:2-3)\n');
    const report = await checkEvidenceHashes(dir);
    assert.equal(report.results.find(item => item.citation === 'src/auth.ts:2')?.status, 'stale');
    assert.equal(report.results.find(item => item.citation === 'src/auth.ts:3')?.status, 'unrecorded');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});


test('grouped and bracketed routes, reference tables and multi-file citations preserve complete identities',async()=>{
 const dir=setup();
 try {
  const route='frontend/app/portfolio/(overview)/[id]/page.tsx';
  mkdirSync(path.dirname(path.join(dir,route)),{recursive:true});
  writeFileSync(path.join(dir,route),'route\nother\n');
  writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),`(evidence: ${route}:L1-L2, src/auth.ts:2)\n## References\n| Topic | Source |\n| route | ${route}:1 |\n`);
  const snapshot=await recordEvidenceHashes(dir);
  assert.ok(snapshot.hashes.some(item=>item.file===route&&item.line===2));
  assert.ok(snapshot.hashes.some(item=>item.file==='src/auth.ts'&&item.line===2));
  assert.ok((await checkEvidenceHashes(dir)).documents.every(item=>item.verified));
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('invalid in-root spans never downgrade to valid whole-file citations',async()=>{
 const dir=setup();
 try {
  for(const span of ['9-2','0','1-999999999','oops']){
   writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),`(evidence: src/auth.ts:${span})\n`);
   const snapshot=await recordEvidenceHashes(dir);
   assert.equal(snapshot.hashes.some(item=>item.file==='src/auth.ts'&&item.line===0),false);
   assert.equal((await checkEvidenceHashes(dir)).documents[0].verified,false);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('excluded runtime examples and in-root credential symlinks never become source evidence',async()=>{
 const dir=setup();
 try {
  const {symlinkSync}=await import('node:fs');
  writeFileSync(path.join(dir,'.env.local'),'fixture-only\n');
  writeFileSync(path.join(dir,'token.json'),'{}\n');
  writeFileSync(path.join(dir,'src/token.ts'),'export const tokenType = true;\n');
  symlinkSync(path.join(dir,'.env.local'),path.join(dir,'src/innocent.ts'));
  writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),'(evidence: src/auth.ts:2, src/token.ts:1, .env.local, token.json)\n');
  const snapshot=await recordEvidenceHashes(dir);
  assert.equal(snapshot.hashes.length,2);
  assert.ok(snapshot.hashes.some(item=>item.file==='src/token.ts'));
  assert.ok((await checkEvidenceHashes(dir)).documents[0].verified);
  writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),'(evidence: src/innocent.ts:1)\n');
  const denied=await recordEvidenceHashes(dir);
  assert.equal(denied.sourceHashes['src/innocent.ts'],undefined);
  assert.equal((await checkEvidenceHashes(dir)).documents[0].verified,false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('navigation marker cannot exempt material claims and URLs/prose do not add evidence',async()=>{
 const dir=setup();
 try {
  writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),'<!-- graphward: navigation-only -->\n# Material\nEverything is authenticated. `https://example.com/file.ts:1`\n');
  const snapshot=await recordEvidenceHashes(dir);
  assert.equal(snapshot.hashes.length,0);
  assert.equal((await checkEvidenceHashes(dir)).documents[0].verified,false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});


test('JSON evidence arrays keep bracketed path identity and whole-file drift is never relocation',async()=>{
 const dir=setup();
 try {
  const route='frontend/app/[id]/page.tsx';
  mkdirSync(path.dirname(path.join(dir,route)),{recursive:true});
  writeFileSync(path.join(dir,route),'route');
  writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),JSON.stringify({evidence:[`${route}:1`, 'src/auth.ts:2']}));
  let snapshot=await recordEvidenceHashes(dir);
  assert.ok(snapshot.hashes.some(item=>item.file===route&&item.line===1));
  assert.ok((await checkEvidenceHashes(dir)).documents[0].verified);
  writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),`(evidence: ${route})`);
  await recordEvidenceHashes(dir);
  writeFileSync(path.join(dir,route),'prefix\nroute');
  const report=await checkEvidenceHashes(dir);
  assert.equal(report.results[0].status,'stale');
 } finally {rmSync(dir,{recursive:true,force:true});}
});


test('navigation exemption requires contained directory pointers and cannot hide material headings',async()=>{
 const dir=setup();
 const outside=mkdtempSync(path.join(os.tmpdir(),'ei-guide-outside-'));
 try {
  const {symlinkSync}=await import('node:fs');
  symlinkSync(outside,path.join(dir,'outside-dir'));
  for(const content of [
   '<!-- graphward: navigation-only -->\n# All requests authenticate\n- `src/`\n',
   '<!-- graphward: navigation-only -->\n# Navigation\n',
   '<!-- graphward: navigation-only -->\n# Navigation\n- `../`\n',
   '<!-- graphward: navigation-only -->\n# Navigation\n- `outside-dir/`\n',
  ]){
   writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),content);
   await recordEvidenceHashes(dir);
   assert.equal((await checkEvidenceHashes(dir)).documents[0].verified,false);
  }
  writeFileSync(path.join(dir,'.graphward/knowledge-base/auth.md'),'<!-- graphward: navigation-only -->\n# Directory map\n- `src/`\n');
  await recordEvidenceHashes(dir);
  assert.equal((await checkEvidenceHashes(dir)).documents[0].navigationOnly,true);
 } finally {rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
