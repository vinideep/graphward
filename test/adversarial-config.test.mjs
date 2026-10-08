import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_ROUTING_CONFIG,
  GW_CONFIG_PATH,
  normalizeRoutingConfig,
  updateRoutingConfig,
} from "../dist/config/index.js";

async function createTempFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gw-challenger-test-"));
  await mkdir(path.join(root, ".graphward"), { recursive: true });
  return root;
}

test("adversarial: extreme thresholds in raw config and environment", async (t) => {
  await t.test("raw.threshold handles NaN, Infinity, -Infinity and non-numbers by falling back to default 0.7", () => {
    const fallbacks = [
      NaN,
      Infinity,
      -Infinity,
      "NaN",
      "Infinity",
      "-Infinity",
      "0.5",
      "not-a-number",
      "",
      "   ",
      null,
      undefined,
      {},
      [],
      true,
      false,
      "\0",
      "\n0.5\n",
    ];

    for (const val of fallbacks) {
      const res = normalizeRoutingConfig({ threshold: val }, {});
      assert.equal(
        res.threshold,
        0.7,
        `Expected fallback 0.7 for threshold=${String(val)}, got ${res.threshold}`,
      );
      assert.equal(typeof res.threshold, "number");
      assert.ok(Number.isFinite(res.threshold));
    }
  });

  await t.test("raw.threshold clamps extreme finite floats to [0.0, 1.0]", () => {
    assert.equal(normalizeRoutingConfig({ threshold: 1e308 }, {}).threshold, 1.0);
    assert.equal(normalizeRoutingConfig({ threshold: -1e308 }, {}).threshold, 0.0);
    assert.equal(normalizeRoutingConfig({ threshold: Number.MAX_VALUE }, {}).threshold, 1.0);
    assert.equal(normalizeRoutingConfig({ threshold: -Number.MAX_VALUE }, {}).threshold, 0.0);
    assert.equal(normalizeRoutingConfig({ threshold: 999999 }, {}).threshold, 1.0);
    assert.equal(normalizeRoutingConfig({ threshold: -999999 }, {}).threshold, 0.0);
    assert.equal(normalizeRoutingConfig({ threshold: 1.000000000001 }, {}).threshold, 1.0);
    assert.equal(normalizeRoutingConfig({ threshold: -0.000000000001 }, {}).threshold, 0.0);

    // Subnormal and boundary floats
    const subnormal = normalizeRoutingConfig({ threshold: 5e-324 }, {}).threshold;
    assert.equal(subnormal, 5e-324);
    assert.ok(subnormal >= 0.0 && subnormal <= 1.0);

    const zero = normalizeRoutingConfig({ threshold: 0 }, {}).threshold;
    assert.equal(zero, 0);

    const one = normalizeRoutingConfig({ threshold: 1 }, {}).threshold;
    assert.equal(one, 1);
  });

  await t.test("env.CODEX_SHIM_THRESHOLD correctly parses valid float string formats and whitespace", () => {
    const raw = { threshold: 0.9 };

    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "0" }).threshold, 0);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "1" }).threshold, 1);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "  0.35  \r\n" }).threshold, 0.35);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: ".5" }).threshold, 0.5);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "000.75" }).threshold, 0.75);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "5e-1" }).threshold, 0.5);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "1e0" }).threshold, 1);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "0x1" }).threshold, 1);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "0x0" }).threshold, 0);
  });

  await t.test("env.CODEX_SHIM_THRESHOLD handles out-of-bounds numbers and non-numeric strings safely", () => {
    const raw = { threshold: 0.85 };

    // Out-of-bounds finite numbers reset to default 0.7
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "1.5" }).threshold, 0.7);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "-0.5" }).threshold, 0.7);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "1e308" }).threshold, 0.7);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "-1e308" }).threshold, 0.7);

    // Non-numeric, NaN, Infinity strings preserve config threshold
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "NaN" }).threshold, 0.85);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "Infinity" }).threshold, 0.85);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "-Infinity" }).threshold, 0.85);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "1e309" }).threshold, 0.85);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "0.5🚀" }).threshold, 0.85);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "0.5; DROP TABLE" }).threshold, 0.85);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "" }).threshold, 0.85);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "   \t\n  " }).threshold, 0.85);
  });
});

test("adversarial: environment variables with weird casing, emojis, spaces, injection strings", async (t) => {
  await t.test("CODEX_SHIM_DISABLE_ROUTER handles casing, whitespace, and injection strings safely", () => {
    // Truthy disable inputs -> enabled: false
    const truthy = ["TrUe", "TRUE", "YeS", "YES", "ON", "on", "1", "  true \t\n", "  1  "];
    for (const val of truthy) {
      const res = normalizeRoutingConfig({ enabled: true }, { CODEX_SHIM_DISABLE_ROUTER: val });
      assert.equal(res.enabled, false, `Expected enabled=false for CODEX_SHIM_DISABLE_ROUTER=${val}`);
    }

    // Falsy disable inputs -> enabled: true
    const falsy = ["FaLsE", "FALSE", "nO", "NO", "oFf", "OFF", "0", "  false  ", "  0  "];
    for (const val of falsy) {
      const res = normalizeRoutingConfig({ enabled: false }, { CODEX_SHIM_DISABLE_ROUTER: val });
      assert.equal(res.enabled, true, `Expected enabled=true for CODEX_SHIM_DISABLE_ROUTER=${val}`);
    }

    // Adversarial / unparseable strings preserve configured enabled
    const adversarial = [
      "🔥",
      "👍",
      "'; DROP TABLE users; --",
      "${jndi:ldap://evil.com}",
      "<script>alert(1)</script>",
      "2",
      "-1",
      "null",
      "undefined",
    ];
    for (const val of adversarial) {
      const resTrue = normalizeRoutingConfig({ enabled: true }, { CODEX_SHIM_DISABLE_ROUTER: val });
      assert.equal(resTrue.enabled, true, `Expected preserved enabled=true for ${val}`);
      const resFalse = normalizeRoutingConfig({ enabled: false }, { CODEX_SHIM_DISABLE_ROUTER: val });
      assert.equal(resFalse.enabled, false, `Expected preserved enabled=false for ${val}`);
    }
  });

  await t.test("CODEX_SHIM_ROUTER_LOG handles casing, whitespace, emojis, and injection strings", () => {
    const raw = { logLevel: "none" };

    // Case-insensitive exact levels
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "VeRbOsE" }).logLevel, "verbose");
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "SuMmArY" }).logLevel, "summary");
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "NoNe" }).logLevel, "none");
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "  VERBOSE  \n" }).logLevel, "verbose");

    // "1" or "true" promotes "none" to "summary"
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "1" }).logLevel, "summary");
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "TrUe" }).logLevel, "summary");
    // If already verbose, "1" does not downgrade
    assert.equal(normalizeRoutingConfig({ logLevel: "verbose" }, { CODEX_SHIM_ROUTER_LOG: "1" }).logLevel, "verbose");

    // "0" or "false" disables logging
    assert.equal(normalizeRoutingConfig({ logLevel: "verbose" }, { CODEX_SHIM_ROUTER_LOG: "0" }).logLevel, "none");
    assert.equal(normalizeRoutingConfig({ logLevel: "verbose" }, { CODEX_SHIM_ROUTER_LOG: "FaLsE" }).logLevel, "none");

    // Emojis and unrecognized injection strings preserve configured logLevel
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "🪵" }).logLevel, "none");
    assert.equal(normalizeRoutingConfig({ logLevel: "verbose" }, { CODEX_SHIM_ROUTER_LOG: "<script>" }).logLevel, "verbose");
  });

  await t.test("CODEX_SHIM_FORCE_MODEL trims whitespace, clears on empty, and safely preserves Unicode/injection names", () => {
    const raw = { forceModel: "default-model" };

    // Trims whitespace
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "  gpt-4o  " }).forceModel, "gpt-4o");

    // Whitespace-only clears forceModel to undefined
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "   \t\n   " }).forceModel, undefined);
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "" }).forceModel, undefined);

    // Unicode / emoji models
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "🤖-gpt-4o" }).forceModel, "🤖-gpt-4o");

    // Injection strings are treated as plain model identifier strings without crashes
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "'; DROP TABLE models; --" }).forceModel, "'; DROP TABLE models; --");
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "__proto__" }).forceModel, "__proto__");
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "constructor" }).forceModel, "constructor");

    // Very large string
    const largeName = "model-".concat("X".repeat(5000));
    assert.equal(normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: largeName }).forceModel, largeName);
  });
});

test("adversarial: updateRoutingConfig concurrency stress and atomic write behavior", async (t) => {
  await t.test("sequential calls update config reliably without error", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
      );

      for (let i = 1; i <= 5; i++) {
        const res = await updateRoutingConfig(root, { threshold: i / 10 });
        assert.equal(res.threshold, i / 10);
      }

      const content = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
      assert.equal(content.routing.threshold, 0.5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("concurrent calls succeed with 100% success and 0 rejections under write serialization and atomic write", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
      );

      // Launch 10 concurrent updateRoutingConfig calls in the same Node process
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(updateRoutingConfig(root, { threshold: 0.1 * ((i % 9) + 1) }));
      }

      const results = await Promise.allSettled(promises);
      const rejections = results.filter((r) => r.status === "rejected");
      const fulfillments = results.filter((r) => r.status === "fulfilled");

      assert.equal(
        rejections.length,
        0,
        `Expected 0 rejections under serialized atomic writes, but got ${rejections.length}`,
      );
      assert.equal(
        fulfillments.length,
        10,
        "Expected all 10 concurrent calls to be fulfilled",
      );

      const content = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
      assert.ok(typeof content.routing.threshold === "number");
      assert.ok(content.routing.threshold >= 0 && content.routing.threshold <= 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("repeated concurrent bursts show 100% success under serialized atomic write pattern", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
      );

      let totalAttempts = 0;
      let totalFailures = 0;

      for (let burst = 0; burst < 3; burst++) {
        const burstPromises = [
          updateRoutingConfig(root, { threshold: 0.2 }),
          updateRoutingConfig(root, { threshold: 0.4 }),
          updateRoutingConfig(root, { threshold: 0.6 }),
        ];
        totalAttempts += burstPromises.length;
        const results = await Promise.allSettled(burstPromises);
        totalFailures += results.filter((r) => r.status === "rejected").length;
      }

      assert.equal(
        totalFailures,
        0,
        `Expected 0 write failures under serialized atomic write pattern, got ${totalFailures} failures out of ${totalAttempts} attempts`,
      );
      assert.equal(totalAttempts, 9);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("concurrent calls produce 0 JSON corruption across multiple trials under serialized atomic writes", async () => {
    // Stress test running multiple trials of concurrent writes to verify zero data corruption
    let corruptionObserved = false;
    let corruptedContent = "";

    for (let trial = 0; trial < 15; trial++) {
      const root = await createTempFixture();
      try {
        await writeFile(
          path.join(root, GW_CONFIG_PATH),
          JSON.stringify({ schemaVersion: 2, routing: { enabled: true, threshold: 0.7 } }),
        );
        const promises = Array.from({ length: 12 }, (_, i) =>
          updateRoutingConfig(root, { threshold: 0.1 * ((i % 9) + 1) }),
        );
        const results = await Promise.allSettled(promises);
        const rejections = results.filter((r) => r.status === "rejected");
        assert.equal(rejections.length, 0, `Trial ${trial} had rejections: ${rejections.length}`);

        const diskContent = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
        try {
          const parsed = JSON.parse(diskContent);
          assert.ok(parsed.routing, "routing section exists in parsed JSON");
        } catch (err) {
          corruptionObserved = true;
          corruptedContent = diskContent;
          break;
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    assert.equal(
      corruptionObserved,
      false,
      `Expected zero corruption across 15 trials, but observed corruption: ${corruptedContent}`,
    );
  });
});
