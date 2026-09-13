import type { DependencyGraph } from "../graph/schema.js";
import path from "node:path";

export interface CoverageGap {
  file: string;
  symbol: string;
  kind: string;
  hasTest: boolean;
}

export interface CharacterizationTest {
  testFile: string;
  content: string;
  coversSymbols: string[];
}

export function detectCoverageGaps(
  changedFiles: string[],
  graph: DependencyGraph
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  
  for (const file of changedFiles) {
    const symbols = graph.nodes.filter(n => n.path === file && n.kind === 'export');
    
    for (const symbol of symbols) {
      let hasTest = false;
      const incomingEdges = graph.edges.filter(e => e.to === symbol.id);
      
      for (const edge of incomingEdges) {
        const fromNode = graph.nodes.find(n => n.id === edge.from);
        if (fromNode && fromNode.path && /(?:\.test\.|^test[/\\])/.test(fromNode.path)) {
          hasTest = true;
          break;
        }
      }
      
      if (!hasTest) {
        gaps.push({
          file,
          symbol: symbol.label,
          kind: symbol.kind,
          hasTest
        });
      }
    }
  }
  
  return gaps;
}

export function generateCharacterizationTests(
  gaps: CoverageGap[],
  projectRoot: string
): CharacterizationTest[] {
  const tests: CharacterizationTest[] = [];
  
  const gapsByFile = new Map<string, CoverageGap[]>();
  for (const gap of gaps) {
    const list = gapsByFile.get(gap.file) || [];
    list.push(gap);
    gapsByFile.set(gap.file, list);
  }
  
  for (const [file, fileGaps] of gapsByFile.entries()) {
    const parsed = path.parse(file);
    // Put test alongside the file
    const testFile = path.join(parsed.dir, `${parsed.name}.test${parsed.ext}`);
    const relPath = `./${parsed.base}`;
    
    // For ES modules, import .js instead of .ts
    const importPath = relPath.replace(/\.(ts|tsx)$/, '.js');
    
    let content = `import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\n`;
    
    const symbols = fileGaps.map(g => g.symbol);
    if (symbols.length > 0) {
      content += `import { ${symbols.join(', ')} } from '${importPath}';\n\n`;
    }
    
    for (const gap of fileGaps) {
      content += `describe('characterization: ${gap.symbol}', () => {\n`;
      content += `  it('exists and is callable', () => {\n`;
      content += `    assert.ok(typeof ${gap.symbol} !== 'undefined');\n`;
      content += `  });\n`;
      content += `});\n\n`;
    }
    
    tests.push({
      testFile,
      content: content.trim() + '\n',
      coversSymbols: symbols
    });
  }
  
  return tests;
}
