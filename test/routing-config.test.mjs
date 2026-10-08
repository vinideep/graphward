import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_CONFIG,
  DEFAULT_ROUTING_CONFIG,
  GW_CONFIG_PATH,
  loadGwConfig,
  migrateGwConfig,
  normalizeConfig,
  normalizeRoutingConfig,
  serializeConfigWrite,
  updateRoutingConfig,
} from "../dist/config/index.js";

async function createTempFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gw-routing-test-"));
  await mkdir(path.join(root, ".graphward"), { recursive: true });
  return root;
}

function withEnv(vars, fn) {
  const original = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (original[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original[key];
        }
      }
    });
}

test("routing-config: baseline defaults and backward compatibility", async (t) => {
  await t.test("exports canonical defaults matching specification", () => {
    assert.equal(DEFAULT_ROUTING_CONFIG.enabled, true);
    assert.equal(DEFAULT_ROUTING_CONFIG.threshold, 0.7);
    assert.equal(DEFAULT_ROUTING_CONFIG.classifier, "gpt-4o-mini");
    assert.equal(DEFAULT_ROUTING_CONFIG.logLevel, "summary");
    assert.ok(Array.isArray(DEFAULT_CAPABILITY_CARDS));
    assert.ok(DEFAULT_CAPABILITY_CARDS.length >= 2);
    assert.equal(DEFAULT_CONFIG.routing.enabled, true);
    assert.equal(DEFAULT_CONFIG.routing.threshold, 0.7);
  });

  await t.test("normalizeRoutingConfig returns default config for undefined or empty input", () => {
    const fromUndef = normalizeRoutingConfig(undefined, {});
    assert.equal(fromUndef.enabled, true);
    assert.equal(fromUndef.threshold, 0.7);
    assert.equal(fromUndef.classifier, "gpt-4o-mini");
    assert.equal(fromUndef.logLevel, "summary");
    assert.ok(Array.isArray(fromUndef.capabilityCards));
    assert.equal(fromUndef.capabilityCards.length, DEFAULT_CAPABILITY_CARDS.length);
    assert.equal(fromUndef.forceModel, undefined);

    const fromEmpty = normalizeRoutingConfig({}, {});
    assert.equal(fromEmpty.enabled, true);
    assert.equal(fromEmpty.threshold, 0.7);
    assert.equal(fromEmpty.classifier, "gpt-4o-mini");
    assert.equal(fromEmpty.logLevel, "summary");
    assert.equal(fromEmpty.forceModel, undefined);
  });

  await t.test("loadGwConfig supplies default routing when routing is omitted in config file", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, tokenBudgets: { get_graph: 100 } }),
      );
      const config = await loadGwConfig(root);
      assert.ok(config.routing);
      assert.equal(config.routing.enabled, true);
      assert.equal(config.routing.threshold, 0.7);
      assert.equal(config.routing.classifier, "gpt-4o-mini");
      assert.equal(config.routing.logLevel, "summary");
      assert.equal(config.tokenBudgets.get_graph, 100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("normalizeConfig incorporates routing with empty env isolation", () => {
    const raw = { tokenBudgets: { test: 10 } };
    const normalized = normalizeConfig(raw, {}, {});
    assert.ok(normalized.routing);
    assert.equal(normalized.routing.enabled, true);
    assert.equal(normalized.routing.threshold, 0.7);
  });
});

test("routing-config: invalid value normalization and safe fallbacks", async (t) => {
  await t.test("clamps out-of-bounds numbers and falls back for non-numbers", () => {
    // Clamping behavior per R2 and test/e2e-routing.test.mjs
    assert.equal(normalizeRoutingConfig({ threshold: -0.5 }, {}).threshold, 0.0);
    assert.equal(normalizeRoutingConfig({ threshold: -100 }, {}).threshold, 0.0);
    assert.equal(normalizeRoutingConfig({ threshold: 1.5 }, {}).threshold, 1.0);
    assert.equal(normalizeRoutingConfig({ threshold: 99.9 }, {}).threshold, 1.0);

    // Non-numeric or NaN falls back to default 0.7
    assert.equal(normalizeRoutingConfig({ threshold: NaN }, {}).threshold, 0.7);
    assert.equal(normalizeRoutingConfig({ threshold: "high" }, {}).threshold, 0.7);
    assert.equal(normalizeRoutingConfig({ threshold: null }, {}).threshold, 0.7);
    assert.equal(normalizeRoutingConfig({ threshold: undefined }, {}).threshold, 0.7);

    // Valid boundaries and floats are strictly preserved
    assert.equal(normalizeRoutingConfig({ threshold: 0.0 }, {}).threshold, 0.0);
    assert.equal(normalizeRoutingConfig({ threshold: 1.0 }, {}).threshold, 1.0);
    assert.equal(normalizeRoutingConfig({ threshold: 0.5 }, {}).threshold, 0.5);
    assert.equal(normalizeRoutingConfig({ threshold: 0.85 }, {}).threshold, 0.85);
  });

  await t.test("normalizes unknown logLevel to safe default 'summary'", () => {
    assert.equal(normalizeRoutingConfig({ logLevel: "ultra" }, {}).logLevel, "summary");
    assert.equal(normalizeRoutingConfig({ logLevel: 123 }, {}).logLevel, "summary");
    assert.equal(normalizeRoutingConfig({ logLevel: null }, {}).logLevel, "summary");

    assert.equal(normalizeRoutingConfig({ logLevel: "none" }, {}).logLevel, "none");
    assert.equal(normalizeRoutingConfig({ logLevel: "summary" }, {}).logLevel, "summary");
    assert.equal(normalizeRoutingConfig({ logLevel: "verbose" }, {}).logLevel, "verbose");
  });

  await t.test("normalizes invalid enabled and classifier", () => {
    assert.equal(normalizeRoutingConfig({ enabled: "no" }, {}).enabled, true);
    assert.equal(normalizeRoutingConfig({ enabled: false }, {}).enabled, false);
    assert.equal(normalizeRoutingConfig({ enabled: true }, {}).enabled, true);

    assert.equal(normalizeRoutingConfig({ classifier: "" }, {}).classifier, "gpt-4o-mini");
    assert.equal(normalizeRoutingConfig({ classifier: "   " }, {}).classifier, "gpt-4o-mini");
    assert.equal(normalizeRoutingConfig({ classifier: 123 }, {}).classifier, "gpt-4o-mini");
    assert.equal(normalizeRoutingConfig({ classifier: "claude-3-haiku" }, {}).classifier, "claude-3-haiku");
  });

  await t.test("normalizes capabilityCards with fallbacks for invalid or empty arrays", () => {
    assert.deepEqual(normalizeRoutingConfig({ capabilityCards: [] }, {}).capabilityCards, DEFAULT_CAPABILITY_CARDS);
    assert.deepEqual(normalizeRoutingConfig({ capabilityCards: "invalid" }, {}).capabilityCards, DEFAULT_CAPABILITY_CARDS);
    assert.deepEqual(normalizeRoutingConfig({ capabilityCards: null }, {}).capabilityCards, DEFAULT_CAPABILITY_CARDS);

    // Custom cards are preserved and normalized
    const customCards = [
      {
        id: "card-fast",
        model: "gpt-4o-mini",
        description: "Fast model",
        strengths: ["quick"],
        costTier: "cheap",
      },
      {
        id: "card-deep",
        model: "gpt-4o",
        description: "Deep reasoning",
        strengths: ["architecture"],
        costTier: "premium",
        contextWindow: 128000,
      },
    ];
    const normalized = normalizeRoutingConfig({ capabilityCards: customCards }, {});
    assert.equal(normalized.capabilityCards.length, 2);
    assert.equal(normalized.capabilityCards[0].id, "card-fast");
    assert.equal(normalized.capabilityCards[1].contextWindow, 128000);
  });
});

test("routing-config: independent environment variable overrides (R5)", async (t) => {
  await t.test("CODEX_SHIM_DISABLE_ROUTER overrides enabled independently", () => {
    const raw = { enabled: true, threshold: 0.85, classifier: "custom-classifier", logLevel: "verbose" };

    const disabled1 = normalizeRoutingConfig(raw, { CODEX_SHIM_DISABLE_ROUTER: "1" });
    assert.equal(disabled1.enabled, false);
    assert.equal(disabled1.threshold, 0.85);
    assert.equal(disabled1.classifier, "custom-classifier");
    assert.equal(disabled1.logLevel, "verbose");

    const disabledTrue = normalizeRoutingConfig(raw, { CODEX_SHIM_DISABLE_ROUTER: "true" });
    assert.equal(disabledTrue.enabled, false);

    const disabledYes = normalizeRoutingConfig(raw, { CODEX_SHIM_DISABLE_ROUTER: "yes" });
    assert.equal(disabledYes.enabled, false);

    const disabledOn = normalizeRoutingConfig(raw, { CODEX_SHIM_DISABLE_ROUTER: "on" });
    assert.equal(disabledOn.enabled, false);

    const enabled0 = normalizeRoutingConfig({ enabled: false }, { CODEX_SHIM_DISABLE_ROUTER: "0" });
    assert.equal(enabled0.enabled, true);

    const enabledFalse = normalizeRoutingConfig({ enabled: false }, { CODEX_SHIM_DISABLE_ROUTER: "false" });
    assert.equal(enabledFalse.enabled, true);
  });

  await t.test("CODEX_SHIM_ROUTER_LOG overrides logLevel independently", () => {
    const raw = { logLevel: "none", threshold: 0.7 };

    const enabledLog = normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "1" });
    assert.equal(enabledLog.logLevel, "summary");
    assert.equal(enabledLog.threshold, 0.7);

    const trueLog = normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "true" });
    assert.equal(trueLog.logLevel, "summary");

    const verboseLog = normalizeRoutingConfig(raw, { CODEX_SHIM_ROUTER_LOG: "verbose" });
    assert.equal(verboseLog.logLevel, "verbose");

    const noneLog = normalizeRoutingConfig({ logLevel: "verbose" }, { CODEX_SHIM_ROUTER_LOG: "0" });
    assert.equal(noneLog.logLevel, "none");

    const explicitNone = normalizeRoutingConfig({ logLevel: "summary" }, { CODEX_SHIM_ROUTER_LOG: "none" });
    assert.equal(explicitNone.logLevel, "none");
  });

  await t.test("CODEX_SHIM_THRESHOLD overrides threshold independently with boundary checking", () => {
    const raw = { threshold: 0.85, enabled: true };

    const overridden = normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "0.25" });
    assert.equal(overridden.threshold, 0.25);
    assert.equal(overridden.enabled, true);

    const boundaryZero = normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "0" });
    assert.equal(boundaryZero.threshold, 0);

    const boundaryOne = normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "1" });
    assert.equal(boundaryOne.threshold, 1);

    // Numeric out-of-bounds falls back to default 0.7
    const invalidNegative = normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "-0.5" });
    assert.equal(invalidNegative.threshold, 0.7);

    const invalidOverflow = normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "1.5" });
    assert.equal(invalidOverflow.threshold, 0.7);

    // Non-numeric string falls back safely to config file threshold
    const nonNumeric = normalizeRoutingConfig(raw, { CODEX_SHIM_THRESHOLD: "not-a-number" });
    assert.equal(nonNumeric.threshold, 0.85);
  });

  await t.test("CODEX_SHIM_FORCE_MODEL overrides forceModel independently", () => {
    const raw = { threshold: 0.7, classifier: "gpt-4o-mini" };

    const forced = normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "gpt-4o" });
    assert.equal(forced.forceModel, "gpt-4o");
    assert.equal(forced.threshold, 0.7);
    assert.equal(forced.classifier, "gpt-4o-mini");

    const trimmed = normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "  claude-3-5-sonnet  " });
    assert.equal(trimmed.forceModel, "claude-3-5-sonnet");

    const emptyForced = normalizeRoutingConfig(raw, { CODEX_SHIM_FORCE_MODEL: "   " });
    assert.equal(emptyForced.forceModel, undefined);
  });
});

test("routing-config: env vars strictly take precedence over gw.config.json", async () => {
  const root = await createTempFixture();
  try {
    await writeFile(
      path.join(root, GW_CONFIG_PATH),
      JSON.stringify({
        schemaVersion: 2,
        routing: {
          enabled: true,
          threshold: 0.9,
          logLevel: "none",
          forceModel: "config-model",
          classifier: "config-classifier",
        },
      }),
    );

    await withEnv(
      {
        CODEX_SHIM_DISABLE_ROUTER: "1",
        CODEX_SHIM_THRESHOLD: "0.35",
        CODEX_SHIM_ROUTER_LOG: "1",
        CODEX_SHIM_FORCE_MODEL: "env-model-override",
      },
      async () => {
        const config = await loadGwConfig(root);
        assert.equal(config.routing.enabled, false);
        assert.equal(config.routing.threshold, 0.35);
        assert.equal(config.routing.logLevel, "summary");
        assert.equal(config.routing.forceModel, "env-model-override");
        // Non-overridden fields must be preserved from config file
        assert.equal(config.routing.classifier, "config-classifier");
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routing-config: migrateGwConfig isolates environment variables from disk", async () => {
  const root = await createTempFixture();
  try {
    // Write legacy config with token budgets and without routing
    await writeFile(
      path.join(root, ".graphward", "config.json"),
      JSON.stringify({ tokenBudgets: { get_graph: 500 } }),
    );

    await withEnv(
      {
        CODEX_SHIM_DISABLE_ROUTER: "1",
        CODEX_SHIM_THRESHOLD: "0.15",
        CODEX_SHIM_ROUTER_LOG: "1",
        CODEX_SHIM_FORCE_MODEL: "ephemeral-model",
      },
      async () => {
        const migration = await migrateGwConfig(root);
        assert.equal(migration.changed, true);

        // Read raw file directly from disk to verify isolation
        const onDisk = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
        assert.ok(onDisk.routing, "routing section must exist on disk");
        // Disk MUST reflect default/file configuration, NOT ephemeral env vars
        assert.equal(onDisk.routing.enabled, true, "enabled on disk must not be polluted by CODEX_SHIM_DISABLE_ROUTER");
        assert.equal(onDisk.routing.threshold, 0.7, "threshold on disk must not be polluted by CODEX_SHIM_THRESHOLD");
        assert.equal(onDisk.routing.forceModel, undefined, "forceModel on disk must not be polluted by CODEX_SHIM_FORCE_MODEL");

        // Running migration again must report no changes
        const recheck = await migrateGwConfig(root);
        assert.equal(recheck.changed, false);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routing-config: updateRoutingConfig atomic persistence and env isolation", async () => {
  const root = await createTempFixture();
  try {
    await writeFile(
      path.join(root, GW_CONFIG_PATH),
      JSON.stringify({
        schemaVersion: 2,
        routing: {
          enabled: true,
          threshold: 0.7,
          classifier: "gpt-4o-mini",
          logLevel: "none",
        },
      }),
    );

    await withEnv(
      {
        CODEX_SHIM_DISABLE_ROUTER: "1",
        CODEX_SHIM_FORCE_MODEL: "do-not-write-me",
      },
      async () => {
        const updated = await updateRoutingConfig(root, {
          threshold: 0.45,
          logLevel: "verbose",
        });

        assert.equal(updated.threshold, 0.45);
        assert.equal(updated.logLevel, "verbose");

        // Inspect raw disk content
        const onDisk = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
        assert.equal(onDisk.routing.threshold, 0.45);
        assert.equal(onDisk.routing.logLevel, "verbose");
        assert.equal(onDisk.routing.enabled, true, "enabled must remain true on disk despite active env var");
        assert.equal(onDisk.routing.forceModel, undefined, "forceModel must not leak to disk from env var");
        assert.equal(onDisk.routing.classifier, "gpt-4o-mini", "unpatched fields must be preserved");
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routing-config: schemas/config.schema.json validates routing configuration", async () => {
  const schemaPath = path.join(new URL("../schemas/config.schema.json", import.meta.url).pathname);
  const rawSchema = JSON.parse(await readFile(schemaPath, "utf8"));

  assert.equal(rawSchema.properties.schemaVersion.const, 2);
  assert.ok(rawSchema.properties.routing, "schema must contain routing property");
  assert.equal(rawSchema.properties.routing.type, "object");

  // routing must NOT be required in top-level required array (backward compatibility)
  assert.ok(Array.isArray(rawSchema.required));
  assert.ok(!rawSchema.required.includes("routing"), "routing must not be in required array");

  // Verify routing properties definition
  const routingProps = rawSchema.properties.routing.properties;
  assert.equal(routingProps.threshold.minimum, 0);
  assert.equal(routingProps.threshold.maximum, 1);
  assert.deepEqual(routingProps.logLevel.enum, ["none", "summary", "verbose"]);
  assert.ok(routingProps.capabilityCards);
  assert.equal(routingProps.capabilityCards.type, "array");
});

test("routing-config: updateRoutingConfig concurrency, atomic persistence, and resilience", async (t) => {
  await t.test(
    "10 concurrent async calls across different fields succeed without collisions and preserve all updates cumulatively",
    async () => {
      const root = await createTempFixture();
      try {
        await writeFile(
          path.join(root, GW_CONFIG_PATH),
          JSON.stringify({
            schemaVersion: 2,
            tokenBudgets: { get_graph: 100 },
            routing: {
              enabled: true,
              threshold: 0.7,
              classifier: "gpt-4o-mini",
              logLevel: "summary",
              capabilityCards: DEFAULT_CAPABILITY_CARDS,
            },
          }, null, 2),
        );

        const customCards = [
          {
            id: "card-fast",
            model: "gpt-4o-mini",
            description: "Fast model for classification and syntax",
            strengths: ["formatting", "fast"],
            costTier: "cheap",
          },
          {
            id: "card-deep",
            model: "gpt-4o",
            description: "High-reasoning model for complex architecture",
            strengths: ["architecture", "refactoring"],
            costTier: "premium",
            contextWindow: 128000,
          },
        ];

        const patches = [
          { threshold: 0.85 },
          { classifier: "claude-3-5-sonnet" },
          { logLevel: "verbose" },
          { forceModel: "gpt-4o" },
          { enabled: false },
          { capabilityCards: customCards },
          { threshold: 0.85 },
          { classifier: "claude-3-5-sonnet" },
          { logLevel: "verbose" },
          { forceModel: "gpt-4o" },
        ];

        const results = await Promise.allSettled(
          patches.map((patch) => updateRoutingConfig(root, patch)),
        );

        const rejections = results.filter((r) => r.status === "rejected");
        assert.equal(
          rejections.length,
          0,
          `Expected all 10 concurrent calls to succeed, but ${rejections.length} failed. First error: ${rejections[0]?.reason?.message}`,
        );

        const fulfillments = results.filter((r) => r.status === "fulfilled");
        assert.equal(fulfillments.length, 10, "All 10 calls must resolve to fulfilled");

        const rawContent = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
        let diskConfig;
        assert.doesNotThrow(() => {
          diskConfig = JSON.parse(rawContent);
        }, "On-disk .graphward/gw.config.json must be 100% valid JSON with no interleaved syntax errors");

        assert.equal(diskConfig.routing.threshold, 0.85, "threshold update must be cumulatively preserved");
        assert.equal(diskConfig.routing.classifier, "claude-3-5-sonnet", "classifier update must be cumulatively preserved");
        assert.equal(diskConfig.routing.logLevel, "verbose", "logLevel update must be cumulatively preserved");
        assert.equal(diskConfig.routing.forceModel, "gpt-4o", "forceModel update must be cumulatively preserved");
        assert.equal(diskConfig.routing.enabled, false, "enabled update must be cumulatively preserved");
        assert.deepEqual(diskConfig.routing.capabilityCards, customCards, "capabilityCards update must be cumulatively preserved");

        assert.equal(diskConfig.schemaVersion, 2, "schemaVersion must remain intact");
        assert.equal(diskConfig.tokenBudgets.get_graph, 100, "tokenBudgets must remain intact");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "20-call high-load burst with rapid interleaving produces valid JSON and zero errors",
    async () => {
      const root = await createTempFixture();
      try {
        await writeFile(
          path.join(root, GW_CONFIG_PATH),
          JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }, null, 2),
        );

        const burstPromises = Array.from({ length: 20 }, (_, i) => {
          const step = (i % 8) + 1;
          const levels = ["none", "summary", "verbose"];
          return updateRoutingConfig(root, {
            threshold: Number((0.1 * step).toFixed(2)),
            logLevel: levels[i % levels.length],
            forceModel: `model-worker-${i % 4}`,
          });
        });

        const burstResults = await Promise.allSettled(burstPromises);
        const burstRejections = burstResults.filter((r) => r.status === "rejected");
        assert.equal(
          burstRejections.length,
          0,
          `Expected 0 rejections across 20 concurrent calls, got ${burstRejections.length}`,
        );

        const diskContent = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
        const parsed = JSON.parse(diskContent);
        assert.ok(typeof parsed.routing.threshold === "number");
        assert.ok(parsed.routing.threshold >= 0 && parsed.routing.threshold <= 1);
        assert.ok(["none", "summary", "verbose"].includes(parsed.routing.logLevel));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "clean temporary file hygiene: no orphaned .tmp-* files remain in .graphward after concurrent writes",
    async () => {
      const root = await createTempFixture();
      try {
        await writeFile(
          path.join(root, GW_CONFIG_PATH),
          JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
        );

        const writes = Array.from({ length: 12 }, (_, i) =>
          updateRoutingConfig(root, { threshold: 0.1 * ((i % 5) + 1) }),
        );
        await Promise.all(writes);

        const files = await readdir(path.join(root, ".graphward"));
        const orphanedTmpFiles = files.filter((f) => f.includes(".tmp"));
        assert.equal(
          orphanedTmpFiles.length,
          0,
          `Expected zero orphaned temporary files in .graphward, found: ${orphanedTmpFiles.join(", ")}`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "concurrent updates preserve unmanaged custom top-level configuration metadata",
    async () => {
      const root = await createTempFixture();
      try {
        const initialFullConfig = {
          schemaVersion: 2,
          customTeamConfig: { lead: "charlie", env: "production", flags: [1, 2, 3] },
          tokenBudgets: { get_graph: 500, find_symbol: 200 },
          providers: { policy: "native", requireProviders: true, exposeRawMcp: false, offline: false },
          hooks: {
            verifyCommands: ["npm test"],
            freshnessThreshold: 80,
            blockStaleEdits: true,
            requireValidationOnStop: true,
          },
          routing: DEFAULT_ROUTING_CONFIG,
        };

        await writeFile(path.join(root, GW_CONFIG_PATH), JSON.stringify(initialFullConfig, null, 2));

        const concurrentUpdates = [
          updateRoutingConfig(root, { threshold: 0.88 }),
          updateRoutingConfig(root, { classifier: "custom-router-classifier" }),
          updateRoutingConfig(root, { logLevel: "verbose" }),
          updateRoutingConfig(root, { forceModel: "gpt-4o" }),
          updateRoutingConfig(root, { enabled: false }),
        ];

        await Promise.all(concurrentUpdates);

        const onDisk = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
        assert.equal(onDisk.routing.threshold, 0.88);
        assert.equal(onDisk.routing.classifier, "custom-router-classifier");
        assert.equal(onDisk.routing.logLevel, "verbose");
        assert.equal(onDisk.routing.forceModel, "gpt-4o");
        assert.equal(onDisk.routing.enabled, false);

        assert.deepEqual(onDisk.customTeamConfig, { lead: "charlie", env: "production", flags: [1, 2, 3] });
        assert.deepEqual(onDisk.tokenBudgets, { get_graph: 500, find_symbol: 200 });
        assert.equal(onDisk.providers.policy, "native");
        assert.equal(onDisk.hooks.freshnessThreshold, 80);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "concurrent calls with active process.env overrides do not pollute on-disk JSON",
    async () => {
      const root = await createTempFixture();
      try {
        await writeFile(
          path.join(root, GW_CONFIG_PATH),
          JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
        );

        await withEnv(
          {
            CODEX_SHIM_THRESHOLD: "0.22",
            CODEX_SHIM_DISABLE_ROUTER: "1",
            CODEX_SHIM_FORCE_MODEL: "ephemeral-env-model",
          },
          async () => {
            const promises = [
              updateRoutingConfig(root, { threshold: 0.91 }),
              updateRoutingConfig(root, { classifier: "disk-classifier" }),
              updateRoutingConfig(root, { logLevel: "verbose" }),
              updateRoutingConfig(root, { enabled: true }),
            ];
            const returns = await Promise.all(promises);

            const lastReturn = returns[returns.length - 1];
            assert.equal(lastReturn.threshold, 0.91, "in-memory return must reflect patched threshold");
            assert.equal(lastReturn.enabled, true, "in-memory return must reflect patched enabled");
            assert.equal(lastReturn.classifier, "disk-classifier", "in-memory return must reflect patched classifier");
            assert.equal(lastReturn.logLevel, "verbose", "in-memory return must reflect patched logLevel");
            assert.equal(lastReturn.forceModel, undefined, "in-memory return must not leak env forceModel");

            const onDisk = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
            assert.equal(onDisk.routing.threshold, 0.91, "disk must record patched threshold, not env threshold");
            assert.equal(onDisk.routing.enabled, true, "disk must record patched enabled, not env disabled");
            assert.equal(onDisk.routing.classifier, "disk-classifier", "disk must record patched classifier");
            assert.equal(onDisk.routing.logLevel, "verbose", "disk must record patched logLevel");
            assert.equal(onDisk.routing.forceModel, undefined, "disk must NOT record env forceModel");

            const loaded = await loadGwConfig(root);
            assert.equal(loaded.routing.threshold, 0.22, "loadGwConfig applies env override");
            assert.equal(loaded.routing.enabled, false, "loadGwConfig applies env disable");
            assert.equal(loaded.routing.forceModel, "ephemeral-env-model", "loadGwConfig applies env forceModel");
          },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "lazy initialization under concurrency: 10 concurrent calls create .graphward directory and initial config safely",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "gw-lazy-init-"));
      try {
        const patches = [
          { threshold: 0.75 },
          { classifier: "lazy-classifier" },
          { logLevel: "verbose" },
          { forceModel: "lazy-model" },
          { enabled: false },
          { threshold: 0.75 },
          { classifier: "lazy-classifier" },
          { logLevel: "verbose" },
          { forceModel: "lazy-model" },
          { enabled: false },
        ];

        const results = await Promise.allSettled(
          patches.map((p) => updateRoutingConfig(root, p)),
        );

        const failures = results.filter((r) => r.status === "rejected");
        assert.equal(
          failures.length,
          0,
          `Expected all lazy initial calls to succeed, got ${failures.length} failures`,
        );

        const onDisk = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
        assert.equal(onDisk.schemaVersion, 2);
        assert.equal(onDisk.routing.threshold, 0.75);
        assert.equal(onDisk.routing.classifier, "lazy-classifier");
        assert.equal(onDisk.routing.logLevel, "verbose");
        assert.equal(onDisk.routing.forceModel, "lazy-model");
        assert.equal(onDisk.routing.enabled, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "queue resilience: isolated failure does not permanently wedge subsequent queued writes",
    async () => {
      const root = await createTempFixture();
      try {
        await writeFile(
          path.join(root, GW_CONFIG_PATH),
          JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
        );

        const configPath = path.join(root, GW_CONFIG_PATH);
        const failedCall = serializeConfigWrite(configPath, async () => {
          throw new Error("simulated serialization failure");
        });
        await assert.rejects(failedCall, { message: "simulated serialization failure" });

        const validCall = await updateRoutingConfig(root, { threshold: 0.44 });
        assert.equal(validCall.threshold, 0.44, "Queue must recover immediately after a prior rejection");

        const onDisk = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
        assert.equal(onDisk.routing.threshold, 0.44);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
