import http from "node:http";
import zlib from "node:zlib";
import type { RawSpan } from "./privacy-policy.js";
import { TracePrivacyPolicy } from "./privacy-policy.js";
import { RuntimeTracer } from "./tracer.js";
import { RuntimeSymbolResolver } from "./symbol-resolver.js";
import { ExecutionFlowTracker } from "./execution-flow.js";

export interface OtlpTracePayload {
  resourceSpans?: Array<{
    resource?: {
      attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }>;
    };
    scopeSpans?: Array<{
      scope?: { name: string; version?: string };
      spans?: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind?: number | string;
        startTimeUnixNano?: string;
        endTimeUnixNano?: string;
        attributes?: Array<{ key: string; value: Record<string, unknown> }>;
        events?: Array<{ name: string; timeUnixNano?: string; attributes?: Array<{ key: string; value: Record<string, unknown> }> }>;
        status?: { code: number; message?: string };
      }>;
    }>;
  }>;
}

export interface IngestionSummary {
  receivedSpans: number;
  acceptedSpans: number;
  droppedSpans: number;
  resolvedCalls: number;
  unresolvedCalls: number;
}

export class OtlpTraceReceiver {
  private server?: http.Server;
  private isRunning = false;

  constructor(
    private resolver: RuntimeSymbolResolver,
    private tracer: RuntimeTracer = new RuntimeTracer(),
    private flowTracker: ExecutionFlowTracker = new ExecutionFlowTracker(),
    private privacyPolicy: TracePrivacyPolicy = new TracePrivacyPolicy()
  ) {}

  /**
   * Starts listening for OTLP traces on specified port (default 4318).
   */
  public async start(port: number = 4318, host: string = "localhost"): Promise<void> {
    if (this.isRunning) return;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(port, host, () => {
        this.isRunning = true;
        resolve();
      });
    });
  }

  /**
   * Stops the HTTP server.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning || !this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.isRunning = false;
        this.server = undefined;
        resolve();
      });
    });
  }

  /**
   * Directly ingests an in-memory OTLP trace payload without network I/O.
   */
  public ingestPayload(payload: OtlpTracePayload): IngestionSummary {
    let received = 0;
    let accepted = 0;
    let dropped = 0;
    let resolvedCalls = 0;
    let unresolvedCalls = 0;

    const spanMap = new Map<string, { raw: RawSpan; durationMs: number }>();

    for (const rs of payload.resourceSpans ?? []) {
      const envAttr = rs.resource?.attributes?.find((a) => a.key === "deployment.environment" || a.key === "environment");
      const environment = envAttr?.value?.stringValue;

      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          received++;

          const rawSpan = this.convertOtlpSpanToRaw(span, environment);
          const sanitizedSpan = this.privacyPolicy.sanitizeSpan(rawSpan);
          if (!sanitizedSpan) {
            dropped++;
            continue;
          }

          const durationMs = this.calculateSpanDurationMs(span.startTimeUnixNano, span.endTimeUnixNano);
          const recorded = this.tracer.recordSpan(sanitizedSpan, durationMs, 0.05);
          if (recorded) {
            accepted++;
            spanMap.set(span.spanId, { raw: sanitizedSpan, durationMs });
          } else {
            dropped++;
          }
        }
      }
    }

    // Correlate parent-child spans to reconstruct caller -> callee runtime flow
    for (const [, child] of spanMap) {
      if (child.raw.parentSpanId && spanMap.has(child.raw.parentSpanId)) {
        const parent = spanMap.get(child.raw.parentSpanId)!;

        const parentFrame = this.extractRuntimeFrame(parent.raw);
        const childFrame = this.extractRuntimeFrame(child.raw);

        if (parentFrame && childFrame) {
          const parentRes = this.resolver.resolve(parentFrame);
          const childRes = this.resolver.resolve(childFrame);

          if (parentRes.status === "RESOLVED" && childRes.status === "RESOLVED") {
            resolvedCalls++;
            this.flowTracker.recordInvocation(
              parentRes.resolvedSymbol!,
              childRes.resolvedSymbol!,
              {
                latencyMs: child.durationMs,
                isError: child.raw.status?.code === 2, // 2 = ERROR in OTel
                testSuite: (child.raw.attributes?.["test.suite"] as string) || (parent.raw.attributes?.["test.suite"] as string),
                route: (child.raw.attributes?.["http.route"] as string) || (parent.raw.attributes?.["http.route"] as string),
                environment: child.raw.environment,
              }
            );
          } else {
            unresolvedCalls++;
          }
        }
      }
    }

    return {
      receivedSpans: received,
      acceptedSpans: accepted,
      droppedSpans: dropped,
      resolvedCalls,
      unresolvedCalls,
    };
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url || "";
    const pathname = rawUrl.split("?")[0];

    if (req.method === "POST" && (pathname === "/v1/traces" || pathname === "/v1/traces/")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const rawBuffer = Buffer.concat(chunks);
          const contentEncoding = (req.headers["content-encoding"] || "").toLowerCase();
          let bodyStr: string;

          if (contentEncoding === "gzip" || contentEncoding === "deflate") {
            try {
              const decompressed = zlib.unzipSync(rawBuffer);
              bodyStr = decompressed.toString("utf-8");
            } catch (decompErr) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "ERROR", message: `Decompression failed: ${String(decompErr)}` }));
              return;
            }
          } else {
            bodyStr = rawBuffer.toString("utf-8");
          }

          const payload = JSON.parse(bodyStr) as OtlpTracePayload;
          const summary = this.ingestPayload(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "OK", summary }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ERROR", message: String(err) }));
        }
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    }
  }

  private convertOtlpSpanToRaw(span: any, environment?: string): RawSpan {
    const attributes: Record<string, unknown> = {};
    if (Array.isArray(span.attributes)) {
      for (const attr of span.attributes) {
        if (attr.value) {
          const val =
            attr.value.stringValue !== undefined
              ? attr.value.stringValue
              : attr.value.intValue !== undefined
              ? attr.value.intValue
              : attr.value.boolValue !== undefined
              ? attr.value.boolValue
              : Object.values(attr.value)[0];
          attributes[attr.key] = val;
        }
      }
    }

    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: String(span.kind ?? "1"),
      startTimeUnixNano: span.startTimeUnixNano,
      endTimeUnixNano: span.endTimeUnixNano,
      attributes,
      status: span.status,
      environment,
    };
  }

  private calculateSpanDurationMs(startNano?: string, endNano?: string): number {
    if (!startNano || !endNano) return 1.0;
    try {
      const start = BigInt(startNano);
      const end = BigInt(endNano);
      return Number(end - start) / 1_000_000;
    } catch {
      return 1.0;
    }
  }

  private extractRuntimeFrame(span: RawSpan): { file: string; line?: number; column?: number; functionName?: string } | null {
    const file =
      (span.attributes?.["code.filepath"] as string) ||
      (span.attributes?.["code.file"] as string) ||
      (span.attributes?.["location.file"] as string) ||
      (span.attributes?.["filename"] as string);

    const line = Number(
      span.attributes?.["code.lineno"] ||
      span.attributes?.["code.line"] ||
      span.attributes?.["location.line"]
    ) || undefined;

    const column = Number(
      span.attributes?.["code.column"] ||
      span.attributes?.["location.column"]
    ) || undefined;

    const functionName =
      (span.attributes?.["code.function"] as string) ||
      (span.attributes?.["code.functionName"] as string) ||
      span.name;

    if (!file && !functionName) return null;

    return {
      file: file || "unknown",
      line,
      column,
      functionName,
    };
  }
}
