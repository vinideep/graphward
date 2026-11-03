# Efficiency record contract

The additive evaluator is `scripts/evaluate-efficiency-runs.mjs`. Existing `evaluate-agent-runs.mjs` and `qualify-release.mjs` contracts are unchanged. This directory contains a protocol, not measured experiment results.

| Artifact | Schema | Meaning |
| --- | --- | --- |
| Frozen specification | `schemas/efficiency-experiment.schema.json` | Full task/split/arm/condition/decision plan, frozen before collection. |
| One measured task run | `schemas/efficiency-record.schema.json` | One task, arm, seed and repetition, including all attempts and maintenance. A results file is an array of these records. |
| Descriptive report | `schemas/efficiency-report.schema.json` | Completeness, accepted-task denominators, disjoint usage, independently available cost/latency; always nonqualifying. |

`efficiencySpecHash(spec)` computes SHA-256 over JSON whose object keys are recursively sorted; array order is preserved. Persist the frozen specification and use this function to bind every run's `specHash` to it. Changing any frozen field requires a distinct hash and an auditable amendment. `artifactHash` is the relevant arm's fixed artifact/configuration digest from `armArtifacts`; its difference across arms does not break pairing.

Use the immutable baseline manifest's `sourceDigest` as `sourceRevision` when evaluating a dirty source snapshot; a Git HEAD alone omits dirty content. Preserve the capture/check utility's returned `digest` and the original manifest in the external evidence ledger. Artifact hashes identify arm-specific tool/configuration snapshots independently of the fixed application source. Verify baseline manifests with the baseline capture/check utility before collecting records. The evaluator checks supplied identities and hashes for consistency; it does not reread a baseline directory or prove its integrity.

The task identity is `(taskId, repository, sourceRevision, model, modelVersion, requestHash, seed)`; the paired observation adds `repetition`. Frozen task checks contain unique `id` and exact `command` values. Each measured check adds `exitCode`, `timedOut`, and `evidenceHash`. The outcome contains `accepted`, all five nonnegative error counts, and its evidence hash. `accepted` must agree with the measured checks and zero-error rule in [PROTOCOL.md](PROTOCOL.md).

Every run has `attemptsAccountingComplete: true`, one first `initial` attempt and subsequent `retry`/`repair` attempts in actual order, with status `succeeded`, `failed`, or `cancelled`. Each attempt and maintenance item has a unique `id` within its arm and a `usage` object:

```json
{
  "accounting": "disjoint",
  "scope": "complete",
  "categories": {
    "uncachedInput": { "availability": "available", "tokens": 100 },
    "cacheWrite": { "availability": "available", "tokens": 30 },
    "cacheRead": { "availability": "available", "tokens": 50 },
    "output": { "availability": "available", "tokens": 20 }
  }
}
```

This is an illustrative shape, not a measured run. For unavailable categories use `{ "availability": "unavailable", "tokens": null }`. Scope may be `partial` or `unknown`; such records cannot establish complete token measurement. All four categories are required. The usage object forbids extra inclusive/total fields. Input normalization belongs to `usageFromTelemetry`, with the precise host rules in the protocol; callers should not reconstruct totals from billed input alone.

Each item can have a measured `cost` of `{ "availability": "available", "value": 0.01, "currency": "USD" }`, or explicit unavailable cost with `value`/`currency` null. Omission remains unavailable. Different currencies are never silently combined. A run's optional `latencyMs` uses `{ "availability": "available", "value": 1000 }` or unavailable/null; omitted latency remains unavailable. Cost and latency do not control token-counter availability.

`maintenance` contains `accountingComplete: true`, an `evidenceHash`, and `items`. Empty items mean measured absence supported by the evidence; missing maintenance is not measured absence. Use the same item shape as attempts without `kind`/`status`. Allocation rules are frozen in the tool-policy manifest. Include every cost/usage event from failed and accepted tasks; do not duplicate an attributed overhead event across task runs or count a linked child after charging its complete parent sample.

The report's `tokens.categories.*.observedTokens` is the sum of available counters only, with `availableItems` and `expectedItems` alongside it. It is not an estimate for unavailable categories. Unsafe sums become null. `tokens.total` and `perAcceptedTask` remain null when the matched experiment's token accounting is incomplete. A complete arm with no accepted tasks has a known total and null ratio. `comparisons.*.tokenReductionPct` is descriptive arithmetic over complete matched ratios only. `measurementComplete` means the frozen collection is complete according to supplied records; `improvementClaim` and `releaseQualification` are always false.

The fixture-backed tests include a concrete telemetry-to-evaluator flow:

```js
const sample = await recordFromTranscript(root, transcriptPath, sessionId, {
  childAccounting: 'complete',
  transcriptRoot: root,
  childTranscripts: explicitlyAuthorizedChildren,
});
const usage = usageFromTelemetry(sample);
const specHash = efficiencySpecHash(frozenSpecification);
// Attach usage to this attempt and supply measured identities/checks/outcomes.
const report = evaluateEfficiencyRuns(frozenSpecification, measuredRecords);
```

This adapter does not invent acceptance, evidence, cost, elapsed time, missing children, or undisclosed attempts. `test/efficiency-evaluation.test.mjs` uses temporary synthetic transcripts and requires the normal project build for its telemetry import; it never scans private transcript stores or performs a paid model call.
