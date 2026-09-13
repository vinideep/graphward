/**
 * GraphWard OS — Benchmark Tasks Catalog
 *
 * 25 curated benchmark tasks representing realistic engineering change scenarios.
 * Each task simulates a real GitHub issue that an AI coding agent might receive.
 * Used for A/B comparison: agent with GraphWard vs. agent without GraphWard.
 */

export const BENCHMARK_TASKS = [
  // ─── Trivial fixes (3) ───────────────────────────────────────────────
  {
    id: "task_01_fix_readme_typo",
    name: "Fix typo in README documentation",
    category: "trivial",
    prompt: `/graphward Fix the typo "dependecy" → "dependency" in README.md line 4 description.`,
    targetFile: "README.md",
    testFile: null,
    riskLevel: "low",
    expectedOutcome: "single-file-edit",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_02_update_copyright_year",
    name: "Update copyright year in LICENSE",
    category: "trivial",
    prompt: `/graphward Update the copyright year in LICENSE from 2024 to 2025.`,
    targetFile: "LICENSE",
    testFile: null,
    riskLevel: "low",
    expectedOutcome: "single-file-edit",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_03_add_jsdoc_to_export",
    name: "Add JSDoc documentation to an exported function",
    category: "trivial",
    prompt: `/graphward Add JSDoc documentation to the hashContent function in src/verify/index.ts describing its purpose and parameters.`,
    targetFile: "src/verify/index.ts",
    testFile: "test/verify.test.mjs",
    riskLevel: "low",
    expectedOutcome: "single-file-edit",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },

  // ─── Single-file bug fixes (5) ──────────────────────────────────────
  {
    id: "task_04_fix_off_by_one_clarity",
    name: "Fix off-by-one in clarity score clamping",
    category: "bugfix",
    prompt: `/graphward The clarity score in src/aidlc/clarification.ts can go negative when multiple penalties stack. Ensure it floors at 0 and caps at 100.`,
    targetFile: "src/aidlc/clarification.ts",
    testFile: "test/aidlc-clarification.test.mjs",
    riskLevel: "low",
    expectedOutcome: "single-file-fix",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_05_fix_stale_lock_detection",
    name: "Fix stale lock detection race condition",
    category: "bugfix",
    prompt: `/graphward The file lock in src/manifest/lock.ts should handle the case where a lock file exists but the process that created it has crashed. Add stale lock detection: if the lock file is older than 5 minutes, consider it abandoned and remove it before acquiring.`,
    targetFile: "src/manifest/lock.ts",
    testFile: "test/lock.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "single-file-fix",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_06_fix_receipt_migration_crash",
    name: "Fix crash when migrating old receipts.json format",
    category: "bugfix",
    prompt: `/graphward readRecords in src/verify/index.ts should gracefully handle a corrupted or empty verification-records.json file instead of throwing a JSON parse error.`,
    targetFile: "src/verify/index.ts",
    testFile: "test/verify.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "single-file-fix",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_07_fix_memory_query_empty",
    name: "Fix queryProjectMemory returning empty when memory dir missing",
    category: "bugfix",
    prompt: `/graphward queryProjectMemory in src/learning/index.ts should return an empty result object instead of throwing when the .graphward/memory directory doesn't exist yet.`,
    targetFile: "src/learning/index.ts",
    testFile: "test/learning.test.mjs",
    riskLevel: "low",
    expectedOutcome: "single-file-fix",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_08_fix_graph_duplicate_nodes",
    name: "Fix duplicate nodes in incremental graph merge",
    category: "bugfix",
    prompt: `/graphward When doing an incremental graph update, mergeIncrementalUpdate in src/graph/builders/dependency.ts can create duplicate nodes if a file is both imported and exporting. Deduplicate by node ID.`,
    targetFile: "src/graph/builders/dependency.ts",
    testFile: "test/graph.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "single-file-fix",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },

  // ─── Multi-file features (5) ────────────────────────────────────────
  {
    id: "task_09_refund_orchestrator",
    name: "Distributed idempotent refund orchestration",
    prompt: `/graphward implement idempotent order refund orchestration in src/orders/refund.ts and comprehensive tests in test/refunds.test.mjs.

Repository Signatures:
- db.getOrder(orderId: string): Order | undefined
- db.saveOrder(order: Order): void
- db.getPaymentByIdempotency(tenantId: string, idempotencyKey: string): PaymentTransaction | undefined
- db.savePayment(payment: PaymentTransaction): void
- db.registerIdempotencyKey(tenantId: string, idempotencyKey: string, paymentId: string): void
- releaseStock(tenantId: string, sku: string, quantity: number): Promise<void>
- eventBus.publish(event: { id: string; type: string; tenantId: string; payload: any; timestamp: string }): Promise<void>

Requirements:
1. Export refundOrder(params: { tenantId: string; orderId: string; reason: string; idempotencyKey: string }): Promise<{ success: boolean; isDuplicate?: boolean; error?: string; refundPaymentId?: string }>
   - If db.getPaymentByIdempotency exists, return { success: true, isDuplicate: true, refundPaymentId: existing.id }
   - Validate order exists, matches tenantId, and status is "paid"
   - Loop order.items and await releaseStock for each
   - Update order.status = "refunded" and save
   - Create and save refund PaymentTransaction, register idempotency key
   - Publish "order.refunded" event
   - Return { success: true, isDuplicate: false, refundPaymentId: payment.id }`,
    category: "feature",
    targetFile: "src/orders/refund.ts",
    testFile: "test/refunds.test.mjs",
    riskLevel: "high",
    expectedOutcome: "multi-file-feature",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_10_add_graph_visualization",
    name: "Add dependency graph DOT export",
    category: "feature",
    prompt: `/graphward Add a 'graphward export-dot .' CLI command that reads the dependency graph from .graphward/graph/dependency-graph.json and outputs a Graphviz DOT format representation to stdout. Each node should show its label and kind, edges should show the relation type.`,
    targetFile: "src/cli/index.ts",
    testFile: "test/graph.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "multi-file-feature",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_11_add_freshness_webhook",
    name: "Add webhook notification for stale intelligence",
    category: "feature",
    prompt: `/graphward Add a configurable webhook URL to gw.config.json that fires a POST request with a JSON payload when intelligence staleness score drops below the threshold. The payload should include { projectName, stalenessScore, staleFiles, timestamp }.`,
    targetFile: "src/freshness/index.ts",
    testFile: "test/freshness.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "multi-file-feature",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_12_add_config_validation",
    name: "Add JSON Schema validation for gw.config.json on load",
    category: "feature",
    prompt: `/graphward When loading gw.config.json, validate it against the JSON Schema in schemas/config.schema.json. If validation fails, log a warning with specific field errors but continue with defaults. Add a 'graphward config validate .' command that reports validation results.`,
    targetFile: "src/config/index.ts",
    testFile: "test/config.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "multi-file-feature",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_13_add_mcp_tool_discovery",
    name: "Add MCP tool auto-discovery from project config",
    category: "feature",
    prompt: `/graphward Add an MCP tool that discovers and lists all available GraphWard tools from the registry, including their descriptions and parameter schemas. Register it as 'list_tools' in the MCP server.`,
    targetFile: "src/mcp/index.ts",
    testFile: "test/mcp-registry.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "multi-file-feature",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },

  // ─── Refactoring (3) ────────────────────────────────────────────────
  {
    id: "task_14_extract_hash_utils",
    name: "Extract hash utilities into shared module",
    category: "refactor",
    prompt: `/graphward Extract hashContent and hashFile from src/verify/index.ts into a new src/utils/hash.ts module. Update all imports across the codebase. Both verify and graph modules use hashing — consolidate.`,
    targetFile: "src/utils/hash.ts",
    testFile: "test/verify.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "multi-file-refactor",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_15_consolidate_gitignore_logic",
    name: "Consolidate .gitignore management into single module",
    category: "refactor",
    prompt: `/graphward Multiple modules (verify, installer, hooks) independently manage .graphward/.gitignore entries. Consolidate all gitignore logic into a single src/manifest/gitignore.ts module with an addEntry(root, entry) function.`,
    targetFile: "src/manifest/gitignore.ts",
    testFile: "test/install-integration.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "multi-file-refactor",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_16_simplify_process_runner",
    name: "Simplify process runner interface",
    category: "refactor",
    prompt: `/graphward The runProcess and runProcessSync functions in src/process/index.ts have overlapping interfaces. Create a unified ProcessOptions type and ensure both functions accept the same options shape with consistent return types.`,
    targetFile: "src/process/index.ts",
    testFile: "test/verify.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "single-file-refactor",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },

  // ─── Security-sensitive changes (3) ──────────────────────────────────
  {
    id: "task_17_add_path_traversal_guard",
    name: "Add path traversal guard to file operations",
    category: "security",
    prompt: `/graphward Add path traversal protection to all file read/write operations in GraphWard. Ensure that no operation can read or write files outside the project root directory. A file path like '../../../etc/passwd' or a symlink pointing outside the project root should be rejected.`,
    targetFile: "src/project-files/index.ts",
    testFile: "test/project-files.test.mjs",
    riskLevel: "high",
    expectedOutcome: "multi-file-security",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_18_sanitize_mcp_inputs",
    name: "Sanitize MCP tool input parameters",
    category: "security",
    prompt: `/graphward Add input sanitization to all MCP tool handlers in src/mcp/consolidated.ts. Validate that string parameters don't contain shell injection characters, file paths are within the project root, and JSON parameters parse without prototype pollution.`,
    targetFile: "src/mcp/consolidated.ts",
    testFile: "test/mcp.test.mjs",
    riskLevel: "high",
    expectedOutcome: "single-file-security",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_19_add_secrets_scan_to_write",
    name: "Run secrets scan before every .graphward/ write",
    category: "security",
    prompt: `/graphward Integrate the secrets scanner from src/manifest/secrets-scan.ts into every write operation that targets .graphward/. If a secret pattern is detected, abort the write and log a warning with the pattern name and file.`,
    targetFile: "src/manifest/secrets-scan.ts",
    testFile: "test/secrets-scan.test.mjs",
    riskLevel: "high",
    expectedOutcome: "multi-file-security",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },

  // ─── API contract changes (2) ───────────────────────────────────────
  {
    id: "task_20_add_api_versioning_to_schema",
    name: "Add schema version migration support",
    category: "api-contract",
    prompt: `/graphward The dependency graph schema is version 1. Add forward migration support: a migrate(graph: unknown) function in src/graph/schema.ts that detects the schema version and applies any necessary transformations to bring it to the current version. Support migrating from a hypothetical v0 format (no schemaVersion field, nodes array only, no edges).`,
    targetFile: "src/graph/schema.ts",
    testFile: "test/graph.test.mjs",
    riskLevel: "high",
    expectedOutcome: "api-contract-change",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_21_deprecate_old_mcp_tool",
    name: "Deprecate an MCP tool with backward compatibility",
    category: "api-contract",
    prompt: `/graphward Deprecate the 'get_engineering_context' MCP tool name in favor of 'build_context'. Keep the old name working but log a deprecation warning. Both names should call the same handler.`,
    targetFile: "src/mcp/consolidated.ts",
    testFile: "test/mcp-registry.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "api-contract-change",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },

  // ─── Performance optimization (2) ───────────────────────────────────
  {
    id: "task_22_cache_graph_in_memory",
    name: "Add in-memory LRU cache for dependency graph loading",
    category: "performance",
    prompt: `/graphward Loading the dependency graph from disk on every MCP tool call is expensive. Add an in-memory cache in src/graph/index.ts that holds the parsed graph and invalidates when the file's mtime changes. Use a simple last-read timestamp check.`,
    targetFile: "src/graph/index.ts",
    testFile: "test/graph.test.mjs",
    riskLevel: "medium",
    expectedOutcome: "performance-optimization",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_23_parallelize_file_hashing",
    name: "Parallelize file hashing in verification",
    category: "performance",
    prompt: `/graphward In src/verify/index.ts, the file hashing in runVerification is sequential (for-of loop with await). Parallelize it using Promise.all with a concurrency limit of 10 to speed up verification on large changesets.`,
    targetFile: "src/verify/index.ts",
    testFile: "test/verify.test.mjs",
    riskLevel: "low",
    expectedOutcome: "performance-optimization",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },

  // ─── Dependency/infrastructure (2) ──────────────────────────────────
  {
    id: "task_24_add_node_version_check",
    name: "Add Node.js version check on CLI startup",
    category: "infrastructure",
    prompt: `/graphward Add a Node.js version check at the top of src/cli/index.ts. If the running Node version is below the minimum required (20.11), print a clear error message and exit with code 1 instead of failing later with cryptic errors.`,
    targetFile: "src/cli/index.ts",
    testFile: null,
    riskLevel: "low",
    expectedOutcome: "single-file-infrastructure",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
  {
    id: "task_25_add_health_check_json",
    name: "Add JSON output format to health check command",
    category: "infrastructure",
    prompt: `/graphward Add a --json flag to the 'graphward health' CLI command that outputs the health check results as a JSON object instead of human-readable text. The JSON should include { healthy: boolean, checks: Array<{ name: string, status: 'pass' | 'fail' | 'warn', message: string }> }.`,
    targetFile: "src/cli/index.ts",
    testFile: null,
    riskLevel: "low",
    expectedOutcome: "single-file-feature",
    adversarialSuite: "benchmark/harness/adversarial.test.mjs",
  },
];
