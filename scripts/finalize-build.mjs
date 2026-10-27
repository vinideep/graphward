import { chmodSync, lstatSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function finalizeBuild(root, outputRoot = path.join(root, "dist")) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'graphward' || typeof pkg.version !== 'string' || !pkg.bin || typeof pkg.bin !== 'object') {
    throw new Error('Invalid GraphWard package identity or bin manifest.');
  }
  const bins = {};
  for (const [name, relative] of Object.entries(pkg.bin)) {
    if (typeof relative !== 'string') throw new Error(`Invalid bin: ${name}`);
    const declaredTarget = path.resolve(root, relative);
    const target = path.resolve(outputRoot, path.relative(path.join(root, "dist"), declaredTarget));
    if (!declaredTarget.startsWith(path.join(root, 'dist') + path.sep) || !target.startsWith(path.resolve(outputRoot) + path.sep) || !lstatSync(target).isFile()) {
      throw new Error(`GraphWard bin must be a regular file under dist: ${name}`);
    }
    const bytes = readFileSync(target);
    if (!bytes.toString('utf8').startsWith('#!/usr/bin/env node\n')) throw new Error(`Missing executable shebang: ${name}`);
    chmodSync(target, 0o755);
    bins[name] = { path: relative, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const modules = {};
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name) && relative !== 'runtime-identity.json') modules[relative] = createHash('sha256').update(readFileSync(path.join(directory, entry.name))).digest('hex');
      else if (entry.isSymbolicLink()) throw new Error(`Runtime modules cannot be symlinks: ${relative}`);
    }
  };
  walk(outputRoot);
  const generation = createHash('sha256').update(JSON.stringify(modules)).digest('hex');
  writeFileSync(path.join(outputRoot, 'runtime-identity.json'), JSON.stringify({ schemaVersion: 2, name: pkg.name, version: pkg.version, generation, modules, bins }, null, 2) + '\n');
}
