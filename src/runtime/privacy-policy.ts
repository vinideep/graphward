import { createHash } from "node:crypto";

export interface PrivacyPolicyConfig {
  redactSecrets?: boolean;
  redactPii?: boolean;
  stripHeaders?: string[];
  sensitiveKeyPatterns?: string[];
  dropPayloads?: boolean;
  maxPayloadBytes?: number;
  samplingRate?: number; // 0.0 to 1.0
  environmentAllowlist?: string[];
}

export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; timeUnixNano?: string | number; attributes?: Record<string, unknown> }>;
  status?: { code: number; message?: string };
  environment?: string;
}

const DEFAULT_STRIP_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
];

const DEFAULT_SENSITIVE_KEY_PATTERNS = [
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "auth",
  "credential",
  "cookie",
  "private_key",
];

// Regex patterns for detecting secrets and PII in strings
const SECRET_REGEXES = [
  /bearer\s+[a-zA-Z0-9_\-\.=:_+/]+/gi,
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/gi, // JWT
  /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi,
];

const PII_REGEXES = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g, // Email
  /\b(?:\d{4}[ -]?){3}\d{4}\b/g, // Credit card (16-digit)
  /\b\d{3}-\d{2}-\d{4}\b/g, // US SSN
];

export class TracePrivacyPolicy {
  private redactSecrets: boolean;
  private redactPii: boolean;
  private stripHeaders: Set<string>;
  private sensitiveKeyPatterns: RegExp[];
  private dropPayloads: boolean;
  private maxPayloadBytes: number;
  private samplingRate: number;
  private environmentAllowlist?: Set<string>;

  constructor(config: PrivacyPolicyConfig = {}) {
    this.redactSecrets = config.redactSecrets ?? true;
    this.redactPii = config.redactPii ?? true;
    this.stripHeaders = new Set(
      (config.stripHeaders ?? DEFAULT_STRIP_HEADERS).map((h) => h.toLowerCase())
    );
    const keyPatterns = config.sensitiveKeyPatterns ?? DEFAULT_SENSITIVE_KEY_PATTERNS;
    this.sensitiveKeyPatterns = keyPatterns.map((p) => new RegExp(p, "i"));
    this.dropPayloads = config.dropPayloads ?? false;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 2048;
    this.samplingRate = Math.max(0, Math.min(1, config.samplingRate ?? 1.0));
    if (config.environmentAllowlist && config.environmentAllowlist.length > 0) {
      this.environmentAllowlist = new Set(config.environmentAllowlist.map((e) => e.toLowerCase()));
    }
  }

  /**
   * Sanitizes and enforces privacy rules on an individual trace span.
   * Returns null if the span is dropped by sampling, environment allowlist, or privacy policy.
   */
  public sanitizeSpan(span: RawSpan): RawSpan | null {
    // 1. Environment Allowlist Check
    if (this.environmentAllowlist && span.environment) {
      if (!this.environmentAllowlist.has(span.environment.toLowerCase())) {
        return null;
      }
    }

    // 2. Deterministic Sampling Check based on traceId
    if (this.samplingRate < 1.0) {
      if (!this.isSampled(span.traceId)) {
        return null;
      }
    }

    // 3. Clone and sanitize attributes
    const sanitizedAttributes: Record<string, unknown> = {};
    if (span.attributes) {
      for (const [key, value] of Object.entries(span.attributes)) {
        const lowerKey = key.toLowerCase();

        // Check if header needs to be stripped
        if (this.isHeaderStripped(lowerKey)) {
          sanitizedAttributes[key] = "[REDACTED_HEADER]";
          continue;
        }

        // Check if key name indicates sensitive field
        if (this.isKeySensitive(lowerKey)) {
          sanitizedAttributes[key] = "[REDACTED_SENSITIVE]";
          continue;
        }

        // Check if payload needs dropping
        if (this.dropPayloads && (lowerKey.includes("body") || lowerKey.includes("payload") || lowerKey.includes("query"))) {
          sanitizedAttributes[key] = "[DROPPED_PAYLOAD]";
          continue;
        }

        sanitizedAttributes[key] = this.sanitizeValue(value);
      }
    }

    // 4. Sanitize span events
    let sanitizedEvents: RawSpan["events"];
    if (span.events) {
      sanitizedEvents = span.events.map((evt) => {
        const evtAttrs: Record<string, unknown> = {};
        if (evt.attributes) {
          for (const [k, v] of Object.entries(evt.attributes)) {
            if (this.isKeySensitive(k.toLowerCase())) {
              evtAttrs[k] = "[REDACTED_SENSITIVE]";
            } else {
              evtAttrs[k] = this.sanitizeValue(v);
            }
          }
        }
        return {
          ...evt,
          attributes: evtAttrs,
        };
      });
    }

    return {
      ...span,
      attributes: sanitizedAttributes,
      events: sanitizedEvents,
    };
  }

  /**
   * Sanitizes an arbitrary value (string, object, array, or primitive).
   */
  public sanitizeValue(val: unknown): unknown {
    if (typeof val === "string") {
      let result = val;

      // Truncate if exceeds max payload bytes
      if (result.length > this.maxPayloadBytes) {
        result = result.slice(0, this.maxPayloadBytes) + "... [TRUNCATED]";
      }

      if (this.redactSecrets) {
        for (const regex of SECRET_REGEXES) {
          result = result.replace(regex, "[REDACTED_SECRET]");
        }
      }

      if (this.redactPii) {
        for (const regex of PII_REGEXES) {
          result = result.replace(regex, "[REDACTED_PII]");
        }
      }

      return result;
    }

    if (Array.isArray(val)) {
      return val.map((item) => this.sanitizeValue(item));
    }

    if (val !== null && typeof val === "object") {
      const sanitizedObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (this.isKeySensitive(k.toLowerCase())) {
          sanitizedObj[k] = "[REDACTED_SENSITIVE]";
        } else {
          sanitizedObj[k] = this.sanitizeValue(v);
        }
      }
      return sanitizedObj;
    }

    return val;
  }

  private isHeaderStripped(key: string): boolean {
    if (this.stripHeaders.has(key)) return true;
    for (const h of this.stripHeaders) {
      if (key.endsWith(h) || key.includes(`header.${h}`)) {
        return true;
      }
    }
    return false;
  }

  private isKeySensitive(key: string): boolean {
    return this.sensitiveKeyPatterns.some((pattern) => pattern.test(key));
  }

  private isSampled(traceId: string): boolean {
    if (this.samplingRate >= 1.0) return true;
    if (this.samplingRate <= 0.0) return false;
    const hash = createHash("md5").update(traceId).digest("hex");
    const num = parseInt(hash.slice(0, 8), 16);
    const fraction = num / 0xffffffff;
    return fraction < this.samplingRate;
  }
}
