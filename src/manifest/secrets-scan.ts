export interface SecretPattern {
  name: string;
  regex: RegExp;
  severity: 'critical' | 'high' | 'medium';
}

export interface ScanResult {
  clean: boolean;
  findings: Array<{ pattern: string; file: string; line: number; severity: string }>;
}

export const DEFAULT_PATTERNS: SecretPattern[] = [
  { name: 'AWS Access Key', regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/, severity: 'critical' },
  { name: 'AWS Secret Key', regex: /aws_?(?:secret)?_?(?:access)?_?(?:key)?\s*[:=]\s*["']?[A-Za-z0-9\/+=]{40}["']?/i, severity: 'critical' },
  { name: 'GitHub Personal Access Token', regex: /ghp_[a-zA-Z0-9]{36}/, severity: 'critical' },
  { name: 'GitHub OAuth Access Token', regex: /gho_[a-zA-Z0-9]{36}/, severity: 'critical' },
  { name: 'GitHub Server-to-Server Token', regex: /ghs_[a-zA-Z0-9]{36}/, severity: 'critical' },
  { name: 'GitHub Personal Access Token (Fine-grained)', regex: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/, severity: 'critical' },
  { name: 'GitLab Token', regex: /glpat-[a-zA-Z0-9\-]{20}/, severity: 'critical' },
  { name: 'Slack Token', regex: /xox[baprs]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{32}/, severity: 'critical' },
  { name: 'Private RSA Key', regex: /-----BEGIN RSA PRIVATE KEY-----/, severity: 'critical' },
  { name: 'Private EC Key', regex: /-----BEGIN EC PRIVATE KEY-----/, severity: 'critical' },
  { name: 'Stripe Secret Key', regex: /sk_(?:test|live)_[0-9a-zA-Z]{24}/, severity: 'critical' },
  { name: 'SendGrid Key', regex: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/, severity: 'critical' },
  { name: 'Twilio API Key', regex: /SK[0-9a-fA-F]{32}/, severity: 'critical' },
  { name: 'NPM Token', regex: /npm_[a-zA-Z0-9]{36}/, severity: 'critical' },
  { name: 'Generic Password in Connection String', regex: /(?:mysql|postgres|mongodb(?:(?:\+srv))?):\/\/(?:[^:]+):(?:[^@]+)@/, severity: 'high' },
  { name: 'Bearer Token', regex: /bearer\s+[a-zA-Z0-9_=\-\.]{20,}/i, severity: 'high' },
  { name: 'Generic API Key', regex: /(?:api_?key|secret|token)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/i, severity: 'high' },
  { name: 'Base64 Encoded Creds', regex: /basic\s+[a-zA-Z0-9_=\-\+]{20,}/i, severity: 'medium' }
];

export function scanContent(content: string, fileName: string, patterns?: SecretPattern[]): ScanResult {
  const effectivePatterns = patterns || DEFAULT_PATTERNS;
  const findings: Array<{ pattern: string; file: string; line: number; severity: string }> = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of effectivePatterns) {
      if (pattern.regex.test(line)) {
        findings.push({ pattern: pattern.name, file: fileName, line: i + 1, severity: pattern.severity });
      }
    }
  }

  return { clean: findings.length === 0, findings };
}

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function scanDirectory(dir: string, patterns?: SecretPattern[]): Promise<ScanResult> {
  const effectivePatterns = patterns || DEFAULT_PATTERNS;
  const findings: Array<{ pattern: string; file: string; line: number; severity: string }> = [];

  async function walk(currentDir: string) {
    try {
      const entries = await readdir(currentDir);
      for (const entry of entries) {
        const fullPath = join(currentDir, entry);
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          await walk(fullPath);
        } else if (stats.isFile()) {
          const content = await readFile(fullPath, 'utf-8');
          const result = scanContent(content, fullPath, effectivePatterns);
          findings.push(...result.findings);
        }
      }
    } catch {
      // ignore
    }
  }

  await walk(dir);
  return { clean: findings.length === 0, findings };
}
