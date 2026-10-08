import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";

import {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_CONFIG,
  DEFAULT_ROUTING_CONFIG,
  GW_CONFIG_PATH,
  LEGACY_CONFIG_PATH,
  defaultGwConfig,
  loadGwConfig,
  migrateGwConfig,
  normalizeConfig,
  normalizeRoutingConfig,
  updateProviderConfig,
  updateRoutingConfig,
} from "../dist/config/index.js";

import { defaultConfigFile } from "../dist/hooks/index.js";

async function createTempFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gw-challenger-compat-"));
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

// ============================================================================
// SUITE 1: JSON Schema Validation Against Fixtures and Configurations (Task 4)
// ============================================================================

test("challenger: schemas/config.schema.json validates fixtures and configs", async (t) => {
  const schemaPath = path.join(new URL("../schemas/config.schema.json", import.meta.url).pathname);
  const schemaContent = JSON.parse(await readFile(schemaPath, "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schemaContent);

  await t.test("schema itself is valid Draft-07 and compiles", () => {
    assert.equal(typeof validate, "function");
    assert.equal(schemaContent.properties.schemaVersion.const, 2);
  });

  await t.test("validates defaultConfigFile() output from src/hooks/index.ts", () => {
    const rendered = JSON.parse(defaultConfigFile());
    const valid = validate(rendered);
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  await t.test("validates canonical full config with hooks and routing", () => {
    const canonical = {
      ...DEFAULT_CONFIG,
      hooks: {
        verifyCommands: ["npm test"],
        freshnessThreshold: 70,
        blockStaleEdits: true,
        requireValidationOnStop: false,
      },
    };
    const valid = validate(canonical);
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  await t.test("validates legacy config WITHOUT routing section (backward compatibility)", () => {
    const legacyConfig = {
      schemaVersion: 2,
      tokenBudgets: { get_graph: 1500, who_calls: 500 },
      projectFiles: {
        roots: ["src"],
        include: ["**/*.ts"],
        exclude: ["node_modules/**"],
      },
      providers: {
        policy: "auto",
        offline: false,
        requireProviders: false,
        exposeRawMcp: false,
      },
      hooks: {
        verifyCommands: ["npm test"],
        freshnessThreshold: 80,
        blockStaleEdits: true,
        requireValidationOnStop: true,
      },
    };
    const valid = validate(legacyConfig);
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  await t.test("validates config with complete custom routing section", () => {
    const configWithRouting = {
      schemaVersion: 2,
      tokenBudgets: {},
      projectFiles: {},
      providers: {
        policy: "native",
        offline: true,
        requireProviders: false,
        exposeRawMcp: true,
      },
      hooks: {
        verifyCommands: [],
        freshnessThreshold: 0,
        blockStaleEdits: false,
        requireValidationOnStop: false,
      },
      routing: {
        enabled: true,
        threshold: 0.85,
        classifier: "claude-3-haiku",
        logLevel: "verbose",
        forceModel: "gpt-4o",
        capabilityCards: [
          {
            id: "card-custom-1",
            model: "claude-3-5-sonnet",
            description: "Advanced reasoning model",
            strengths: ["coding", "architecture", "analysis"],
            costTier: "premium",
            contextWindow: 200000,
          },
          {
            id: "card-custom-2",
            model: "gpt-4o-mini",
            description: "Fast helper",
            strengths: ["syntax", "comments"],
            costTier: "cheap",
          },
        ],
      },
    };
    const valid = validate(configWithRouting);
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  await t.test("validates config with partial routing section (only enabled or threshold)", () => {
    const partialRouting = {
      schemaVersion: 2,
      tokenBudgets: {},
      projectFiles: {},
      providers: {
        policy: "auto",
        offline: false,
        requireProviders: false,
        exposeRawMcp: false,
      },
      hooks: {
        verifyCommands: [],
        freshnessThreshold: 50,
        blockStaleEdits: false,
        requireValidationOnStop: false,
      },
      routing: {
        threshold: 0.5,
      },
    };
    const valid = validate(partialRouting);
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  await t.test("validates config preserving extra custom user fields (open object)", () => {
    const configWithExtra = {
      schemaVersion: 2,
      tokenBudgets: { get_graph: 100 },
      projectFiles: {},
      providers: {
        policy: "auto",
        offline: false,
        requireProviders: false,
        exposeRawMcp: false,
      },
      hooks: {
        verifyCommands: [],
        freshnessThreshold: 50,
        blockStaleEdits: false,
        requireValidationOnStop: false,
      },
      negativeConstraintTTLDays: 30,
      clarityThreshold: 85,
      myCustomUserField: "preserved",
      nestedUserMetadata: { author: "team-alpha", version: 1.0 },
    };
    const valid = validate(configWithExtra);
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  // Adversarial negative checks: schema must strictly reject invalid data
  await t.test("strictly rejects routing threshold < 0", () => {
    const bad = {
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_ROUTING_CONFIG, threshold: -0.1 },
    };
    const valid = validate(bad);
    assert.equal(valid, false);
    assert.ok(validate.errors.some((e) => e.instancePath.includes("threshold")));
  });

  await t.test("strictly rejects routing threshold > 1", () => {
    const bad = {
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_ROUTING_CONFIG, threshold: 1.05 },
    };
    const valid = validate(bad);
    assert.equal(valid, false);
    assert.ok(validate.errors.some((e) => e.instancePath.includes("threshold")));
  });

  await t.test("strictly rejects invalid logLevel enum", () => {
    const bad = {
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_ROUTING_CONFIG, logLevel: "debug" },
    };
    const valid = validate(bad);
    assert.equal(valid, false);
    assert.ok(validate.errors.some((e) => e.instancePath.includes("logLevel")));
  });

  await t.test("strictly rejects capabilityCard missing required fields", () => {
    const bad = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_ROUTING_CONFIG,
        capabilityCards: [{ id: "bad-card" }],
      },
    };
    const valid = validate(bad);
    assert.equal(valid, false);
    assert.ok(validate.errors.some((e) => e.instancePath.includes("capabilityCards")));
  });

  await t.test("strictly rejects capabilityCard with invalid costTier enum", () => {
    const bad = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_ROUTING_CONFIG,
        capabilityCards: [
          {
            id: "card-1",
            model: "test-model",
            description: "test",
            strengths: ["a"],
            costTier: "free",
          },
        ],
      },
    };
    const valid = validate(bad);
    assert.equal(valid, false);
    assert.ok(validate.errors.some((e) => e.instancePath.includes("costTier")));
  });

  await t.test("strictly rejects schemaVersion != 2", () => {
    const bad = {
      ...DEFAULT_CONFIG,
      schemaVersion: 1,
    };
    const valid = validate(bad);
    assert.equal(valid, false);
    assert.ok(validate.errors.some((e) => e.instancePath.includes("schemaVersion")));
  });

  await t.test("strictly rejects missing required top-level fields (e.g. providers)", () => {
    const bad = {
      schemaVersion: 2,
      tokenBudgets: {},
      projectFiles: {},
      hooks: {
        verifyCommands: [],
        freshnessThreshold: 50,
        blockStaleEdits: false,
        requireValidationOnStop: false,
      },
    };
    const valid = validate(bad);
    assert.equal(valid, false);
    assert.ok(validate.errors.some((e) => e.params?.missingProperty === "providers"));
  });
});

// ============================================================================
// SUITE 2: Legacy config.json and gw.config.json Loading Fidelity (Task 2)
// ============================================================================

test("challenger: legacy repository loading and migration fidelity", async (t) => {
  const schemaPath = path.join(new URL("../schemas/config.schema.json", import.meta.url).pathname);
  const schemaContent = JSON.parse(await readFile(schemaPath, "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schemaContent);

  await t.test("loads legacy repo with ONLY .graphward/config.json with 100% fidelity", async () => {
    const root = await createTempFixture();
    try {
      const legacyContent = {
        tokenBudgets: { get_graph: 3500, who_calls: 750, map_dependencies: 120 },
      };
      await writeFile(path.join(root, LEGACY_CONFIG_PATH), JSON.stringify(legacyContent, null, 2));

      // 1. loadGwConfig must preserve tokenBudgets with 100% fidelity
      const loaded = await loadGwConfig(root);
      assert.equal(loaded.schemaVersion, 2);
      assert.equal(loaded.tokenBudgets.get_graph, 3500);
      assert.equal(loaded.tokenBudgets.who_calls, 750);
      assert.equal(loaded.tokenBudgets.map_dependencies, 120);

      // Routing must be safely synthesized with complete defaults
      assert.ok(loaded.routing, "routing must be present on loaded config");
      assert.equal(loaded.routing.enabled, true);
      assert.equal(loaded.routing.threshold, 0.7);
      assert.equal(loaded.routing.classifier, "gpt-4o-mini");
      assert.equal(loaded.routing.logLevel, "summary");
      assert.deepEqual(loaded.routing.capabilityCards, DEFAULT_CAPABILITY_CARDS);

      // 2. migrateGwConfig must write gw.config.json, preserve legacy file, and consolidate
      const migration = await migrateGwConfig(root);
      assert.equal(migration.changed, true);

      // Check legacy file is NOT deleted
      const legacyRaw = await readFile(path.join(root, LEGACY_CONFIG_PATH), "utf8");
      assert.ok(legacyRaw.length > 0, "legacy config.json must not be deleted");

      // Check persisted gw.config.json content
      const persisted = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
      assert.equal(persisted.schemaVersion, 2);
      assert.equal(persisted.tokenBudgets.get_graph, 3500);
      assert.ok(persisted.routing);
      assert.equal(persisted.routing.enabled, true);
      assert.equal(persisted.routing.threshold, 0.7);

      // Second migration must be idempotent
      const migration2 = await migrateGwConfig(root);
      assert.equal(migration2.changed, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("loads existing repo with gw.config.json WITHOUT routing with 100% fidelity", async () => {
    const root = await createTempFixture();
    try {
      const existingConfig = {
        schemaVersion: 2,
        tokenBudgets: { get_graph: 2500, analyze_impact: 1200 },
        projectFiles: {
          roots: ["src", "packages/core"],
          include: ["**/*.ts", "**/*.tsx"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
        providers: {
          policy: "native",
          offline: true,
          requireProviders: false,
          exposeRawMcp: true,
        },
        hooks: {
          verifyCommands: ["npm test", "npm run typecheck"],
          freshnessThreshold: 80,
          blockStaleEdits: true,
          requireValidationOnStop: true,
        },
        negativeConstraintTTLDays: 21,
        clarityThreshold: 88,
        customTeamConfig: { lead: "charlie", env: "production" },
      };
      await writeFile(path.join(root, GW_CONFIG_PATH), JSON.stringify(existingConfig, null, 2));

      // 1. Load config
      const loaded = await loadGwConfig(root);
      assert.equal(loaded.schemaVersion, 2);
      assert.equal(loaded.tokenBudgets.get_graph, 2500);
      assert.equal(loaded.tokenBudgets.analyze_impact, 1200);
      assert.deepEqual(loaded.projectFiles.roots, ["src", "packages/core"]);
      assert.deepEqual(loaded.projectFiles.include, ["**/*.ts", "**/*.tsx"]);
      assert.deepEqual(loaded.projectFiles.exclude, ["**/node_modules/**", "**/dist/**"]);
      assert.equal(loaded.providers.policy, "native");
      assert.equal(loaded.providers.offline, true);
      assert.equal(loaded.providers.exposeRawMcp, true);
      assert.deepEqual(loaded.hooks.verifyCommands, ["npm test", "npm run typecheck"]);
      assert.equal(loaded.hooks.freshnessThreshold, 80);
      assert.equal(loaded.hooks.blockStaleEdits, true);
      assert.equal(loaded.hooks.requireValidationOnStop, true);
      assert.equal(loaded.negativeConstraintTTLDays, 21);
      assert.equal(loaded.clarityThreshold, 88);
      assert.deepEqual(loaded.customTeamConfig, { lead: "charlie", env: "production" });

      // Routing must be seamlessly populated
      assert.ok(loaded.routing);
      assert.equal(loaded.routing.enabled, true);
      assert.equal(loaded.routing.threshold, 0.7);

      // 2. updateRoutingConfig must mutate routing WITHOUT disturbing existing fields
      const patched = await updateRoutingConfig(root, { threshold: 0.82, logLevel: "verbose" });
      assert.equal(patched.threshold, 0.82);
      assert.equal(patched.logLevel, "verbose");

      const onDiskAfterRouteUpdate = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
      assert.equal(onDiskAfterRouteUpdate.routing.threshold, 0.82);
      assert.equal(onDiskAfterRouteUpdate.routing.logLevel, "verbose");
      // Verify all original fields survived intact
      assert.deepEqual(onDiskAfterRouteUpdate.projectFiles.roots, ["src", "packages/core"]);
      assert.equal(onDiskAfterRouteUpdate.providers.policy, "native");
      assert.equal(onDiskAfterRouteUpdate.hooks.freshnessThreshold, 80);
      assert.deepEqual(onDiskAfterRouteUpdate.customTeamConfig, { lead: "charlie", env: "production" });
      assert.equal(onDiskAfterRouteUpdate.negativeConstraintTTLDays, 21);
      assert.equal(validate(onDiskAfterRouteUpdate), true, JSON.stringify(validate.errors));

      // 3. updateProviderConfig must preserve newly configured routing
      await updateProviderConfig(root, { offline: false });
      const onDiskAfterProviderUpdate = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
      assert.equal(onDiskAfterProviderUpdate.providers.offline, false);
      assert.equal(onDiskAfterProviderUpdate.routing.threshold, 0.82);
      assert.equal(onDiskAfterProviderUpdate.routing.logLevel, "verbose");
      assert.deepEqual(onDiskAfterProviderUpdate.customTeamConfig, { lead: "charlie", env: "production" });
      assert.equal(validate(onDiskAfterProviderUpdate), true, JSON.stringify(validate.errors));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("merges legacy config.json and gw.config.json (both without routing) with correct priority", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, LEGACY_CONFIG_PATH),
        JSON.stringify({
          tokenBudgets: { legacy_only: 500, shared_budget: 100 },
          legacyExtra: "old",
        }),
      );
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({
          schemaVersion: 2,
          tokenBudgets: { gw_only: 800, shared_budget: 999 },
          gwExtra: "new",
        }),
      );

      const loaded = await loadGwConfig(root);
      assert.equal(loaded.tokenBudgets.legacy_only, 500);
      assert.equal(loaded.tokenBudgets.gw_only, 800);
      assert.equal(loaded.tokenBudgets.shared_budget, 999, "gw.config.json must take precedence for shared keys");
      assert.equal(loaded.gwExtra, "new");
      assert.ok(loaded.routing);

      const migration = await migrateGwConfig(root);
      assert.equal(migration.changed, true);

      const migrated = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
      assert.equal(migrated.tokenBudgets.legacy_only, 500);
      assert.equal(migrated.tokenBudgets.shared_budget, 999);
      assert.equal(migrated.tokenBudgets.gw_only, 800);
      assert.ok(migrated.routing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("gracefully handles corrupted, malformed, or empty configs without throwing", async () => {
    const root = await createTempFixture();
    try {
      // 1. Completely empty file
      await writeFile(path.join(root, GW_CONFIG_PATH), "");
      const configEmpty = await loadGwConfig(root);
      assert.equal(configEmpty.schemaVersion, 2);
      assert.ok(configEmpty.routing);
      assert.equal(configEmpty.routing.enabled, true);

      // 2. Malformed JSON syntax
      await writeFile(path.join(root, GW_CONFIG_PATH), "{ bad: json syntax, ");
      const configMalformed = await loadGwConfig(root);
      assert.equal(configMalformed.schemaVersion, 2);
      assert.ok(configMalformed.routing);
      assert.equal(configMalformed.routing.enabled, true);

      // 3. Array instead of object
      await writeFile(path.join(root, GW_CONFIG_PATH), "[1, 2, 3]");
      const configArray = await loadGwConfig(root);
      assert.equal(configArray.schemaVersion, 2);
      assert.ok(configArray.routing);

      // 4. Primitive string
      await writeFile(path.join(root, GW_CONFIG_PATH), '"just-a-string"');
      const configString = await loadGwConfig(root);
      assert.equal(configString.schemaVersion, 2);
      assert.ok(configString.routing);

      // 5. Completely missing directory
      const missingDir = path.join(os.tmpdir(), "nonexistent-dir-" + Date.now());
      const configMissing = await loadGwConfig(missingDir);
      assert.equal(configMissing.schemaVersion, 2);
      assert.ok(configMissing.routing);
      assert.equal(configMissing.routing.threshold, 0.7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// SUITE 3: Disk Isolation Under Active Adversarial Environment Overrides
// ============================================================================

test("challenger: disk isolation during legacy migration and provider update", async (t) => {
  const root = await createTempFixture();
  try {
    // Write legacy config
    await writeFile(
      path.join(root, LEGACY_CONFIG_PATH),
      JSON.stringify({ tokenBudgets: { get_graph: 1000 } }),
    );

    // Active adversarial environment variables
    await withEnv(
      {
        CODEX_SHIM_DISABLE_ROUTER: "1",
        CODEX_SHIM_THRESHOLD: "0.22",
        CODEX_SHIM_ROUTER_LOG: "none",
        CODEX_SHIM_FORCE_MODEL: "malicious-leak-model",
      },
      async () => {
        // Run migration
        await migrateGwConfig(root);

        // Read raw disk JSON
        const onDisk = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
        assert.equal(onDisk.routing.enabled, true, "enabled must NOT leak env override to disk");
        assert.equal(onDisk.routing.threshold, 0.7, "threshold must NOT leak env override to disk");
        assert.equal(onDisk.routing.logLevel, "summary", "logLevel must NOT leak env override to disk");
        assert.equal(onDisk.routing.forceModel, undefined, "forceModel must NOT leak env override to disk");

        // Now run updateProviderConfig under the same env
        await updateProviderConfig(root, { offline: true });
        const onDiskAfterProvider = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
        assert.equal(onDiskAfterProvider.routing.enabled, true);
        assert.equal(onDiskAfterProvider.routing.threshold, 0.7);
        assert.equal(onDiskAfterProvider.routing.forceModel, undefined);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ============================================================================
// SUITE 4: Cross-Subsystem Backward Compatibility Across GraphWard (Task 1)
// ============================================================================

test("challenger: cross-subsystem backward compatibility with legacy repositories", async (t) => {
  const { createConsolidatedRegistry } = await import("../dist/mcp/consolidated.js");
  const { ProjectFilePolicy } = await import("../dist/project-files/index.js");
  const { loadHookConfig } = await import("../dist/hooks/index.js");

  await t.test("createConsolidatedRegistry initializes against legacy repository without routing", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({
          schemaVersion: 2,
          tokenBudgets: { get_graph: 1200 },
          projectFiles: { roots: ["src"] },
          providers: { policy: "auto", offline: false, requireProviders: false, exposeRawMcp: false },
          hooks: { verifyCommands: [], freshnessThreshold: 50, blockStaleEdits: false, requireValidationOnStop: false },
        }),
      );

      const registry = await createConsolidatedRegistry(root);
      assert.ok(registry);
      const tools = registry.list();
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
      assert.ok(tools.some((t) => t.name === "get_engineering_context" || t.name === "validate_change"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("ProjectFilePolicy.load executes against legacy repository without routing", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({
          schemaVersion: 2,
          tokenBudgets: {},
          projectFiles: {
            roots: ["src", "packages"],
            include: ["**/*.ts"],
            exclude: ["**/temp/**"],
          },
          providers: { policy: "auto", offline: false, requireProviders: false, exposeRawMcp: false },
          hooks: { verifyCommands: [], freshnessThreshold: 50, blockStaleEdits: false, requireValidationOnStop: false },
        }),
      );

      const policy = await ProjectFilePolicy.load(root);
      assert.ok(policy);
      assert.deepEqual(policy.config.roots, ["src", "packages"]);
      assert.deepEqual(policy.config.include, ["**/*.ts"]);
      assert.deepEqual(policy.config.exclude, ["**/temp/**"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("loadHookConfig executes against legacy repository with legacy .graphward/config.json", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, LEGACY_CONFIG_PATH),
        JSON.stringify({ tokenBudgets: { get_graph: 500 } }),
      );

      const hookConfig = await loadHookConfig(root);
      assert.ok(hookConfig);
      assert.equal(typeof hookConfig.freshnessThreshold, "number");
      assert.equal(typeof hookConfig.blockStaleEdits, "boolean");
      assert.ok(Array.isArray(hookConfig.verifyCommands));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

