import test from "node:test";
import assert from "node:assert/strict";
import { ResourceGovernor } from "../dist/governor/resource-governor.js";

test("resource-governor: initialization and metrics", () => {
  const governor = new ResourceGovernor({
    maxIndexQueueDepth: 10,
    maxEmbeddingQueueDepth: 50,
  });

  const metrics = governor.getMetrics();
  assert.ok(metrics.heapUsedBytes > 0);
  assert.ok(metrics.heapLimitBytes > 0);
  assert.ok(typeof metrics.cpuPercentage === "number");
  assert.equal(metrics.indexQueueDepth, 0);
  assert.equal(metrics.maxIndexQueueDepth, 10);
  assert.equal(metrics.embeddingQueueDepth, 0);
  assert.equal(metrics.maxEmbeddingQueueDepth, 50);
  assert.ok(["NORMAL", "MEDIUM_PRESSURE", "HIGH_PRESSURE"].includes(metrics.degradationLevel));
});

test("resource-governor: 3-stage degradation pipeline logic", () => {
  const governor = new ResourceGovernor();

  // 1. Normal (<65%)
  const normalLevel = governor.getDegradationLevel(50);
  assert.equal(normalLevel, "NORMAL");
  const normalPolicy = governor.getActivePolicy(normalLevel);
  assert.equal(normalPolicy.enableTypechecking, true);
  assert.equal(normalPolicy.enableEmbeddings, true);
  assert.equal(normalPolicy.enableRuntimeTracing, true);
  assert.equal(normalPolicy.allowBackgroundVectorization, true);

  // 2. Medium Pressure (65-80%)
  const mediumLevel = governor.getDegradationLevel(72);
  assert.equal(mediumLevel, "MEDIUM_PRESSURE");
  const mediumPolicy = governor.getActivePolicy(mediumLevel);
  assert.equal(mediumPolicy.enableTypechecking, false, "Compiler should be disabled under medium pressure");
  assert.equal(mediumPolicy.enableEmbeddings, true);
  assert.equal(mediumPolicy.allowBackgroundVectorization, false, "Background vectorization should be paused");

  // 3. High Pressure (>80%)
  const highLevel = governor.getDegradationLevel(85);
  assert.equal(highLevel, "HIGH_PRESSURE");
  const highPolicy = governor.getActivePolicy(highLevel);
  assert.equal(highPolicy.enableTypechecking, false);
  assert.equal(highPolicy.enableEmbeddings, false);
  assert.equal(highPolicy.enableRuntimeTracing, false);
  assert.equal(highPolicy.enableFtsSearch, true, "FTS search remains active even under high pressure");
});

test("resource-governor: queue depth budget enforcement", () => {
  const governor = new ResourceGovernor({
    maxIndexQueueDepth: 3,
    maxEmbeddingQueueDepth: 2,
  });

  // Index queue
  assert.equal(governor.enqueueIndexTask(), true);
  assert.equal(governor.enqueueIndexTask(), true);
  assert.equal(governor.enqueueIndexTask(), true);
  // Reaches limit 3
  assert.equal(governor.enqueueIndexTask(), false, "Should reject task when index queue is full");

  governor.dequeueIndexTask();
  assert.equal(governor.enqueueIndexTask(), true, "Should accept task after dequeue");

  // Embedding queue
  assert.equal(governor.enqueueEmbeddingTask(), true);
  assert.equal(governor.enqueueEmbeddingTask(), true);
  assert.equal(governor.enqueueEmbeddingTask(), false, "Should reject when embedding queue is full");
});

test("resource-governor: IOPS and runtime storage tracking", () => {
  const governor = new ResourceGovernor();

  governor.recordIoOperation(1024); // 1KB
  governor.recordIoOperation(2048); // 2KB

  const metrics = governor.getMetrics();
  assert.equal(metrics.runtimeStorageBytes, 3072);
  assert.ok(metrics.iopsCurrent >= 2);
});

test("resource-governor: formatResourceReport CLI report", () => {
  const governor = new ResourceGovernor();
  governor.enqueueIndexTask();
  const report = governor.formatResourceReport();

  assert.ok(report.includes("GraphWard Resource Governor"));
  assert.ok(report.includes("Memory"));
  assert.ok(report.includes("CPU"));
  assert.ok(report.includes("Index Queue"));
  assert.ok(report.includes("Embedding Queue"));
  assert.ok(report.includes("Degradation Level"));
  assert.ok(report.includes("Active Policy"));
});

test("resource-governor: explicit ResourceBudget and ResourceState latency tracking", () => {
  const governor = new ResourceGovernor({
    maxLatencyMs: 200,
    maxHeapBytes: 1024 * 1024 * 1024,
    maxCpuPct: 75,
    maxIoBytesPerSec: 40 * 1024 * 1024,
    maxDiskBytes: 4 * 1024 * 1024 * 1024,
    maxQueueDepth: 50,
  });

  const budget = governor.getResourceBudget();
  assert.equal(budget.maxLatencyMs, 200);
  assert.equal(budget.maxHeapBytes, 1024 * 1024 * 1024);
  assert.equal(budget.maxCpuPct, 75);
  assert.equal(budget.maxIoBytesPerSec, 40 * 1024 * 1024);
  assert.equal(budget.maxDiskBytes, 4 * 1024 * 1024 * 1024);
  assert.equal(budget.maxQueueDepth, 50);

  // Normal latency
  governor.recordQueryLatency(50);
  let state = governor.getResourceState();
  assert.equal(state.latencyPressure, 0.25);
  assert.ok(["NORMAL", "DEGRADED", "CRITICAL"].includes(state.state));

  // High latency pressure
  governor.recordQueryLatency(180);
  state = governor.getResourceState();
  assert.equal(state.latencyPressure, 0.9);
  assert.equal(state.state, "CRITICAL", "High latency pressure >= 0.8 should trigger CRITICAL state");
});
