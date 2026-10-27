import { preflight, postflight, type FlightRecord } from "../flight/index.js";
import { runGate, GATE_NAMES, type GateName } from "../gates/index.js";
import { runProcess, runProcessSync } from "../process/index.js";
import { analyzeImpact } from "../graph/index.js";
import { measureMetric, compareMetric } from "./metric.js";
import { recordExperiment } from "./ledger.js";
import { attachExperimentToGraph } from "./graph-sync.js";
import { createIsolatedWorktree } from "./workspace.js";
import { captureCandidateOwnership, candidateOwnershipMatches, captureExperimentBaseline, restoreExperimentBaseline } from "./baseline.js";
import type {
  EvaluateStepOptions,
  ExperimentRecord,
  ExperimentVerdict,
  RevertReason,
  TierGateResult,
  TierTestResult,
  TierMetricResult,
} from "./types.js";

function git(root: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  return runProcessSync({ command: "git", args, cwd: root, timeoutMs: 15_000 });
}

export async function rollbackTargetFiles(
  root: string,
  files: string[],
  flightRecord?: FlightRecord | null,
): Promise<void> {
  if (!flightRecord) throw new Error("Captured experiment baseline required; destructive rollback refused.");
  await restoreExperimentBaseline(root, flightRecord.id, files);
}

export async function startExperiment(
  root: string,
  options: { goal: string; hypothesis: string; targetFile: string },
): Promise<FlightRecord> {
  const flight = await preflight(root, {
    intent: `[Autoresearch] ${options.goal}: ${options.hypothesis}`,
    files: [options.targetFile],
  });
  await captureExperimentBaseline(root, flight.id, [options.targetFile]);
  return flight;
}

export async function evaluateExperimentStep(
  root: string,
  options: EvaluateStepOptions,
): Promise<ExperimentRecord> {
  if (options.useWorktree) {
    return evaluateInWorktree(root, options);
  }
  return evaluateInPlace(root, options);
}

async function evaluateInWorktree(
  root: string,
  options: EvaluateStepOptions,
): Promise<ExperimentRecord> {
  const mainOwnership = await captureCandidateOwnership(root, [options.targetFile]);
  const session = await createIsolatedWorktree(root, {
    id: `exp-${Date.now().toString(36)}`,
    copyDirty: true, // evaluate the frozen candidate overlay, including untracked inputs
  });
  try {
    // Run the experiment inside the worktree — never touches the main workspace
    const record = await evaluateInPlace(session.worktreeDir, {
      ...options,
      autoRollback: false, // No need to rollback in worktree, we just discard it
      commitOnKeep: false, // Don't commit in worktree, we patch back instead
      useWorktree: false, // Prevent recursion
    });

    record.candidateHash = session.candidateHash;
    record.candidateScope = session.candidateScope;
    if (!await candidateOwnershipMatches(root, mainOwnership) || !await session.candidateStillCurrent?.()) {
      record.verdict = "ERROR";
      record.revertReason = "candidate_drift";
      record.qualified = false;
      record.tierResults.gates = { ...record.tierResults.gates, status: "unavailable", summary: "Main candidate bytes, mode, HEAD, index or overlay changed during measurement; promotion refused and later work preserved." };
    }
    if (record.verdict === "KEEP") {
      // The measured overlay is already present in main; applying it twice can
      // corrupt or conflict with pre-existing staged/unstaged work.
      if (options.commitOnKeep) {
        const committed = git(root, [
          "commit",
          "--only",
          "-m",
          `autoresearch(${options.targetFile}): ${options.hypothesis} [${record.deltaPercent}%]`,
          "--", options.targetFile,
        ]);
        if (committed.exitCode !== 0) { record.verdict = "ERROR"; record.revertReason = "command_error"; record.qualified = false; }
      }
    }
    // REVERT/ERROR: worktree is discarded on cleanup — zero risk to main workspace

    // Record in main workspace ledger, not worktree ledger
    await recordExperiment(root, record);
    await attachExperimentToGraph(root, record);

    return record;
  } finally {
    await session.cleanup();
  }
}

async function evaluateInPlace(
  root: string,
  options: EvaluateStepOptions,
): Promise<ExperimentRecord> {
  const ownership = await captureCandidateOwnership(root, [options.targetFile]);
  let restored = false;
  let committed = false;
  const startedAt = new Date().toISOString();
  const id = `exp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  const autoRollback = options.autoRollback ?? true;
  const filesToRollback = [options.targetFile];

  let verdict: ExperimentVerdict = "REVERT";
  let revertReason: RevertReason | undefined;
  let flightId = options.flightId || "";

  const tierGates: TierGateResult = { status: options.skipGates ? "skipped" : "pass", summary: options.skipGates ? "Safety gates explicitly skipped; metric result is unqualified." : "Executed safety registry.", checks: [] };
  let tierTest: TierTestResult = { status: "unavailable", outputSummary: "No executable scoped tests were selected." };
  let tierMetric: TierMetricResult | undefined;
  const stillOwned = async (): Promise<boolean> => {
    if (await candidateOwnershipMatches(root, ownership)) return true;
    verdict = "ERROR";
    revertReason = "candidate_drift";
    tierGates.status = "unavailable";
    tierGates.summary = "Candidate bytes, mode, HEAD or index changed during evaluation; rollback and promotion refused, later work preserved.";
    return false;
  };
  const rollbackOwned = async () => {
    if (!await stillOwned()) return;
    await rollbackTargetFiles(root, filesToRollback, flightRecord);
    restored = true;
  };

  // 1. Audit scope via Flight Recorder
  const flightResult = await postflight(root, options.flightId ? { id: options.flightId } : {});
  const flightRecord = "record" in flightResult ? flightResult.record : null;
  if ("record" in flightResult) {
    flightId = flightResult.record.id;
    if (flightResult.report.verdict === "flagged") {
      verdict = "REVERT";
      revertReason = "out_of_bounds";
      if (autoRollback) {
        // Unowned edits may be another actor's work. Restore only the target
        // captured by startExperiment and preserve every other changed path.
        await rollbackOwned();
        tierGates.summary += " Out-of-scope edits were preserved; only the owned experiment target was restored.";
      }
      return finishRecord();
    }
  }

  // 2. Tier 1: Deterministic Safety Gates
  if (!options.skipGates) {
    const gatesToCheck: readonly GateName[] = GATE_NAMES;
    for (const gate of gatesToCheck) {
      try {
        const res = await runGate(gate, root, { changedFiles: [options.targetFile], risk: "medium" });
        if (!await stillOwned()) return finishRecord();
        tierGates.checks!.push({ gate, status: res.status, summary: res.summary });
        if (res.status === "unavailable") { tierGates.status = "unavailable"; tierGates.summary = "Required evidence or gate execution is unavailable; metric result is unqualified."; }
        else if (res.status === "warn" && tierGates.status === "pass") tierGates.status = "warn";
        if (res.status === "fail") {
          tierGates.status = "fail";
          tierGates.failedGate = gate;
          tierGates.summary = res.summary;
          verdict = "REVERT";
          revertReason = "gate_failed";
          if (autoRollback) {
            await rollbackOwned();
          }
          return finishRecord();
        }
      } catch (error) {
        tierGates.status = "unavailable";
        tierGates.summary = "Gate execution unavailable; metric result is unqualified.";
        tierGates.checks!.push({ gate, status: "unavailable", summary: String(error) });
      }
    }
  }

  // 3. Tier 2: Scoped Tests
  let testCmd = options.testCommand;
  if (!testCmd) {
    try {
      const impact = await analyzeImpact(root, [options.targetFile]);
      if (impact.testsToRun.length > 0) {
        // If node test suite exists
        testCmd = `node --test ${impact.testsToRun.join(" ")}`;
      }
    } catch {
      // test derivation non-fatal
    }
  }

  if (testCmd) {
    const [tCmd, ...tArgs] = testCmd.split(" ");
    if (tCmd) {
      const testRes = await runProcess({
        command: tCmd,
        args: tArgs,
        cwd: root,
        timeoutMs: 60_000,
      });

      tierTest = {
        status: testRes.exitCode === 0 ? "pass" : "fail",
        command: testCmd,
        exitCode: testRes.exitCode,
        outputSummary: (testRes.stdout || testRes.stderr).slice(0, 200),
      };
      if (!await stillOwned()) return finishRecord();

      if (testRes.exitCode !== 0) {
        verdict = "REVERT";
        revertReason = "test_failed";
        if (autoRollback) {
          await rollbackOwned();
        }
        return finishRecord();
      }
    }
  }

  // 4. Tier 3: Empirical Metric Evaluation
  try {
    const measureResult = await measureMetric(root, options.metricConfig);
    tierMetric = compareMetric(options.baselineValue, measureResult.value, options.metricConfig);
    if (!await stillOwned()) return finishRecord();

    if (tierMetric.improved) {
      verdict = "KEEP";
      revertReason = undefined;

      if (options.commitOnKeep) {
        if (!await stillOwned()) return finishRecord();
        const commitResult = git(root, [
          "commit",
          "--only",
          "-m",
          `autoresearch(${options.targetFile}): ${options.hypothesis} [${tierMetric.deltaPercent}%]`,
          "--", options.targetFile,
        ]);
        if (commitResult.exitCode !== 0) throw new Error(`Experiment commit failed: ${commitResult.stderr}`);
        committed = true;
      }
    } else {
      verdict = "REVERT";
      revertReason = "metric_regressed";
      if (autoRollback) {
        await rollbackOwned();
      }
    }
  } catch (err) {
    verdict = "ERROR";
    revertReason = "command_error";
    if (autoRollback) {
      await rollbackOwned();
    }
  }

  return finishRecord();

  async function finishRecord(): Promise<ExperimentRecord> {
    if (!restored && !committed) await stillOwned();
    const closedAt = new Date().toISOString();
    const currentSha = git(root, ["rev-parse", "HEAD"]).stdout.trim() || undefined;

    const record: ExperimentRecord = {
      schemaVersion: 1,
      id,
      goal: options.goal,
      hypothesis: options.hypothesis,
      targetFile: options.targetFile,
      targetSymbol: options.targetSymbol,
      baselineValue: options.baselineValue,
      measuredValue: tierMetric?.measured,
      deltaPercent: tierMetric?.deltaPercent,
      verdict,
      revertReason,
      tierResults: {
        gates: tierGates,
        tests: tierTest,
        metric: tierMetric,
      },
      flightId,
      createdAt: startedAt,
      closedAt,
      gitCommit: currentSha,
      qualified: tierGates.status === "pass" && tierTest.status === "pass" && verdict === "KEEP",
    };

    await recordExperiment(root, record);
    await attachExperimentToGraph(root, record);

    return record;
  }
}
