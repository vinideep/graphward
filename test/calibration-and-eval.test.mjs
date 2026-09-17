import assert from "node:assert/strict";
import test from "node:test";
import { EmpiricalCalibrationModel } from "../dist/graph/calibration.js";
import { GRAPH_SCHEMA_VERSION, MCP_API_VERSION } from "../dist/graph/schema.js";

test("EmpiricalCalibrationModel: records outcomes, computes ECE and Brier score", () => {
  const model = new EmpiricalCalibrationModel(10);

  // Record simulated well-calibrated predictions
  for (let i = 0; i < 50; i++) {
    // 0.9 confidence: 90% positive
    const success90 = i % 10 !== 0;
    model.recordObservation(0.9, success90);

    // 0.5 confidence: 50% positive
    const success50 = i % 2 === 0;
    model.recordObservation(0.5, success50);

    // 0.1 confidence: 10% positive
    const success10 = i % 10 === 0;
    model.recordObservation(0.1, success10);
  }

  const report = model.getReport();
  assert.equal(report.sampleSize, 150);
  assert.ok(report.expectedCalibrationError < 0.15, `ECE ${report.expectedCalibrationError} should be small`);
  assert.ok(report.brierScore < 0.25, `Brier score ${report.brierScore} should be low`);

  // Test calibration mapping
  const cal90 = model.calibrate(0.9);
  assert.ok(cal90 >= 0.80 && cal90 <= 0.95);
});

test("Schema version locks: graph_schema and mcp_api locked to 2.2", () => {
  assert.equal(GRAPH_SCHEMA_VERSION, "2.2");
  assert.equal(MCP_API_VERSION, "2.2");
});
