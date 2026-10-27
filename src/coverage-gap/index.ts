import type { DependencyGraph } from "../graph/schema.js";
import path from "node:path";
import { factualEdge } from "../graph/trust.js";

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
    const key = file.replace(/\.[^.\/]+$/, "");
    const symbols = graph.nodes.filter(n => (n.path === file || n.path === key || n.metadata.sourcePath === file) && (n.kind === 'export' || n.kind === 'symbol' && n.metadata.exported === true));
    
    for (const symbol of symbols) {
      let hasTest = false;
      const incomingEdges = graph.edges.filter(e => e.to === symbol.id && factualEdge(e));
      
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
    
    let content = `// Optional characterization scaffold. Supply and review a behavioral oracle.\nimport { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\n`;
    
    const symbols = fileGaps.map(g => g.symbol);
    if (symbols.length > 0) {
      content += `import { ${symbols.join(', ')} } from '${importPath}';\n\n`;
    }
    
    for (const gap of fileGaps) {
      content += `describe('characterization: ${gap.symbol}', () => {\n`;
      content += `  it('captures behavior for ${gap.symbol}', async (t) => {\n`;
      content += `    assert.ok(typeof ${gap.symbol} !== 'undefined');\n`;
      content += `    assert.equal(typeof t?.assert?.snapshot, 'function', 'Characterization unavailable: configure snapshot support and review the captured oracle before use');\n`;
      content += `    const result = typeof ${gap.symbol} === 'function' ? await ${gap.symbol}() : ${gap.symbol};\n`;
      content += `    t.assert.snapshot(result);\n`;
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
