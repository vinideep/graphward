import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCanonicalPath, computeProviderSourceSnapshot } from "../providers/workspace.js";
import { withLock } from "../manifest/lock.js";
import { getEngineeringContext } from "../context/orchestrator.js";
import { readContextPreparation } from "../context/preparation.js";
import { loadGwConfig } from "../config/index.js";

export interface TaskQuestion { id: string; question: string; options: string[]; answer?: string }
export interface TaskContract {
  kind: "feature" | "fix" | "refactor";
  request: string;
  intendedUsers: string[];
  behavior: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  scope: string[];
  constraints: string[];
  questions: TaskQuestion[];
}
export interface TaskDecisionReceipt {
  schemaVersion: 1; taskId: string; projectRoot: string; revision: number; revisionHash: string;
  contract: TaskContract; updatedAt: string;
  confirmation?: { source: "host-user-prompt" | "host-question-response" | "operator-conversation"; assurance: "host-observed" | "conversational"; host: string; sessionId: string; eventHash: string; quote: string; confirmedAt: string; revisionHash: string };
  context?: { preparationId: string; sourceGeneration: string; retrievedAt: string; contribution: unknown; unknowns: string[]; requiresDecision: boolean };
  changeMapping?: Array<{ criterion: string; files: string[]; tests: string[]; rationale: string }>;
  degradedDecision?: { sourceGeneration: string; eventHash: string; acceptedAt: string };
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const identifier = (value: string) => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid task ID."); return value; };
const taskPath = (root: string, id: string) => path.join(root, ".graphward/aidlc/tasks", `${identifier(id)}.json`);
const bindingPath = (root: string, host: string, session: string) => path.join(root, ".graphward/aidlc/tasks/sessions", `${digest(`${host}:${session}`)}.json`);

function strings(value: unknown, field: string, required = false): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new Error(`${field} must contain nonempty strings.`);
  if (required && !value.length) throw new Error(`${field} cannot be empty.`);
  return value as string[];
}
export function validateTaskContract(input: unknown): TaskContract {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A complete task contract is required.");
  const value = input as Record<string, unknown>;
  const allowed = ["kind", "request", "intendedUsers", "behavior", "nonGoals", "acceptanceCriteria", "scope", "constraints", "questions"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown contract field: ${key}`);
  if (!["feature", "fix", "refactor"].includes(value.kind as string) || typeof value.request !== "string" || !value.request.trim()) throw new Error("Task kind and request are required.");
  if (!Array.isArray(value.questions)) throw new Error("Complete questions and answers are required.");
  const ids = new Set<string>();
  const questions = value.questions.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid task question.");
    const q = item as TaskQuestion;
    if (!q.id || ids.has(q.id) || typeof q.question !== "string" || !q.question.trim() || q.answer !== undefined && (typeof q.answer !== "string" || !q.answer.trim())) throw new Error("Questions need unique IDs, full text and nonempty answers when supplied.");
    ids.add(q.id);
    return { id: q.id, question: q.question, options: strings(q.options, "question options"), ...(q.answer ? { answer: q.answer } : {}) };
  });
  return {
    kind: value.kind as TaskContract["kind"], request: value.request,
    intendedUsers: strings(value.intendedUsers, "intendedUsers", value.kind === "feature"),
    behavior: strings(value.behavior, "behavior", true), nonGoals: strings(value.nonGoals, "nonGoals"),
    acceptanceCriteria: strings(value.acceptanceCriteria, "acceptanceCriteria", true), scope: strings(value.scope, "scope", true),
    constraints: strings(value.constraints, "constraints"), questions,
  };
}
async function atomic(location: string, value: unknown) {
  await mkdir(path.dirname(location), { recursive: true }); const temporary = `${location}.tmp-${randomUUID()}`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n"); await rename(temporary, location); }
  finally { const { rm } = await import("node:fs/promises"); await rm(temporary, { force: true }); }
}
export async function loadTask(root: string, taskId: string): Promise<TaskDecisionReceipt | undefined> {
  try {
    const receipt = JSON.parse(await readFile(taskPath(root, taskId), "utf8")) as TaskDecisionReceipt;
    const contract = validateTaskContract(receipt.contract);
    if (receipt.schemaVersion !== 1 || receipt.taskId !== taskId || receipt.projectRoot !== toCanonicalPath(root) || !Number.isInteger(receipt.revision) || receipt.revision < 1 || receipt.revisionHash !== digest(JSON.stringify(contract))) throw new Error("Task identity or revision is invalid.");
    return receipt;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function confirmationChallenge(task: TaskDecisionReceipt) { return `Approve GraphWard task ${task.taskId} revision ${task.revision} ${task.revisionHash}`; }
export async function proposeTask(root: string, input: unknown, options: { taskId?: string; host?: string; sessionId?: string } = {}) {
  root = toCanonicalPath(root); const contract = validateTaskContract(input); const taskId = identifier(options.taskId ?? randomUUID());
  return withLock(root, async () => {
    const previous = await loadTask(root, taskId);
    for (const question of contract.questions) {
      const prior = previous?.contract.questions.find(item => item.id === question.id && item.question === question.question && JSON.stringify(item.options) === JSON.stringify(question.options));
      if (!question.answer && prior?.answer) question.answer = prior.answer;
    }
    const revisionHash = digest(JSON.stringify(contract));
    const task: TaskDecisionReceipt = previous?.revisionHash === revisionHash ? previous : { schemaVersion: 1, taskId, projectRoot: root, revision: (previous?.revision ?? 0) + 1, revisionHash, contract, updatedAt: new Date().toISOString() };
    await atomic(taskPath(root, taskId), task);
    if (options.host && options.sessionId) await atomic(bindingPath(root, options.host, options.sessionId), { taskId, projectRoot: root });
    return { task, challenge: confirmationChallenge(task), status: task.confirmation ? "confirmed" : "confirmation-required" };
  }, { name: ".task-contract.lock" });
}
export async function resolveSessionTask(root: string, host: string, sessionId: string): Promise<TaskDecisionReceipt | undefined> {
  try { const binding = JSON.parse(await readFile(bindingPath(root, host, sessionId), "utf8")); return await loadTask(root, binding.taskId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Only native hook adapters call this; it is deliberately absent from MCP tools. */
export async function observeUserPrompt(root: string, host: string, sessionId: string, prompt: string) {
  if (!host || !sessionId || !prompt) return { confirmed: false };
  return withLock(root, async () => {
    const task = await resolveSessionTask(root, host, sessionId); if (!task) return { confirmed: false };
    if (prompt.trim() === confirmationChallenge(task)) {
      if (task.contract.questions.some(q => !q.answer)) return { confirmed: false, reason: "Unanswered requirements questions remain." };
      task.confirmation = { source: "host-user-prompt", assurance: "host-observed", host, sessionId, eventHash: digest(prompt), quote: prompt, confirmedAt: new Date().toISOString(), revisionHash: task.revisionHash };
      await atomic(taskPath(root, task.taskId), task); return { confirmed: true, taskId: task.taskId };
    }
    const preparation = await readContextPreparation(root);
    const challenge = `Accept reduced context for GraphWard task ${task.taskId} ${task.revisionHash} generation ${preparation?.sourceGeneration}`;
    if (preparation && (preparation.status === "degraded" || task.context?.requiresDecision) && prompt.trim() === challenge) {
      task.degradedDecision = { sourceGeneration: preparation.sourceGeneration, eventHash: digest(prompt), acceptedAt: new Date().toISOString() };
      await atomic(taskPath(root, task.taskId), task); return { confirmed: false, degradedAccepted: true };
    }
    return { confirmed: false };
  }, { name: ".task-contract.lock" });
}
export async function bindTaskContext(root: string, taskId: string) {
  const task = await loadTask(root, taskId); if (!task?.confirmation || task.confirmation.revisionHash !== task.revisionHash) throw new Error("Confirmed current requirements are required before implementation context.");
  const preparation = await readContextPreparation(root); const source = await computeProviderSourceSnapshot(root);
  if (!preparation || preparation.projectRoot !== toCanonicalPath(root) || preparation.sourceGeneration !== source.workspaceHash || ["blocked", "cancelled"].includes(preparation.status)) throw new Error("Current successful context preparation is required.");
  const context = await getEngineeringContext(root, { task: task.contract.request, files: task.contract.scope });
  return withLock(root, async () => {
    const latest = await loadTask(root, taskId);
    if (!latest || latest.revisionHash !== task.revisionHash || (await computeProviderSourceSnapshot(root)).workspaceHash !== source.workspaceHash) throw new Error("Task revision or source changed during retrieval.");
    latest.context = { preparationId: preparation.id, sourceGeneration: source.workspaceHash, retrievedAt: context.generatedAt, contribution: context.providerContribution, unknowns: context.unknowns, requiresDecision: context.requiresDecision === true };
    await atomic(taskPath(root, taskId), latest); return { task: latest, context };
  }, { name: ".task-contract.lock" });
}
export async function checkTaskReadiness(root: string, options: { taskId?: string; host?: string; sessionId?: string; stage?: "requirements" | "implementation"; files?: string[] } = {}) {
  const blockers: string[] = [];
  const task = options.taskId ? await loadTask(root, options.taskId) : options.host && options.sessionId ? await resolveSessionTask(root, options.host, options.sessionId) : undefined;
  if (!task) return { ready: false, blockers: ["No task contract is bound to this task/session."], confirmationAssurance: "unavailable" };
  if (!task.confirmation || task.confirmation.revisionHash !== task.revisionHash || !task.confirmation.quote || task.confirmation.eventHash !== digest(task.confirmation.quote) || !["host-user-prompt", "host-question-response", "operator-conversation"].includes(task.confirmation.source) ||
      task.confirmation.source === "host-user-prompt" && (task.confirmation.assurance !== "host-observed" || task.confirmation.quote.trim() !== confirmationChallenge(task)) ||
      task.confirmation.source === "host-question-response" && (task.confirmation.assurance !== "host-observed" || task.confirmation.host !== "claude-code" || !task.confirmation.quote.includes(confirmationChallenge(task))) ||
      task.confirmation.source === "operator-conversation" && task.confirmation.assurance !== "conversational") blockers.push("Current scope requires a recorded user confirmation; assistant assertions do not authorize work.");
  if (task.contract.questions.some(question => !question.answer)) blockers.push("Requirements questions remain unanswered.");
  if (task.contract.kind === "feature" && !task.contract.questions.length) blockers.push("Every new feature requires a requirements discussion, including confirmation of a fully specified scope.");
  for (const file of options.files ?? []) {
    const relative = path.relative(toCanonicalPath(root), path.resolve(root, file)).replace(/\\/g, "/");
    if (relative.startsWith("../") || path.isAbsolute(relative) || !task.contract.scope.some(scope => relative === scope || relative.startsWith(`${scope.replace(/\/$/, "")}/`))) blockers.push(`File is outside confirmed authorization scope: ${file}`);
  }
  if (options.stage !== "requirements") {
    const preparation = await readContextPreparation(root); const generation = (await computeProviderSourceSnapshot(root)).workspaceHash;
    const config = await loadGwConfig(root);
    if (preparation?.policy !== config.providers.policy || preparation?.requireProviders !== config.providers.requireProviders) blockers.push("Provider policy changed; prepare and retrieve context under the current policy.");
    if (!preparation || preparation.projectRoot !== task.projectRoot || preparation.sourceGeneration !== generation || !task.context || task.context.sourceGeneration !== generation || task.context.preparationId !== preparation.id) blockers.push("Prepare and retrieve current task context before implementation; ordinary edits do not revoke scope confirmation.");
    if (preparation?.status === "blocked" || preparation?.status === "cancelled") blockers.push(`Context preparation is ${preparation.status}.`);
    if ((preparation?.requiresDecision || task.context?.requiresDecision) && task.degradedDecision?.sourceGeneration !== generation) blockers.push(`Reduced coverage requires a user decision: Accept reduced context for GraphWard task ${task.taskId} ${task.revisionHash} generation ${generation}`);
  }
  return { ready: !blockers.length, taskId: task.taskId, revision: task.revision, revisionHash: task.revisionHash, blockers, confirmationAssurance: task.confirmation?.assurance ?? "unavailable" };
}

/** Operator fallback for hosts without an observable user-prompt hook. Never exposed over MCP. */
export async function confirmTaskInteractively(root: string, taskId: string, session: { host: string; sessionId: string }, reduced = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Operator confirmation requires an interactive terminal. Agent-provided arguments cannot approve a task.");
  const task = await loadTask(root, taskId); if (!task) throw new Error("Unknown task.");
  if (task.contract.questions.some(question => !question.answer)) throw new Error("Answer unresolved requirements questions before confirmation.");
  const preparation = await readContextPreparation(root);
  const challenge = reduced ? `Accept reduced context for GraphWard task ${taskId} ${task.revisionHash} generation ${preparation?.sourceGeneration}` : confirmationChallenge(task);
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let response: string;
  try { console.log(JSON.stringify({ contract: task.contract, revision: task.revision, revisionHash: task.revisionHash, preparation: reduced ? preparation : undefined }, null, 2)); response = await terminal.question(`Enter exactly: ${challenge}\n> `); } finally { terminal.close(); }
  if (response !== challenge) throw new Error("Confirmation did not match the reviewed task revision.");
  return withLock(root, async () => {
    const current = await loadTask(root, taskId);
    if (!current || current.revisionHash !== task.revisionHash) throw new Error("Task changed during review.");
    if (reduced) {
      const latest = await readContextPreparation(root);
      if (!preparation || !latest || latest.id !== preparation.id || latest.sourceGeneration !== (await computeProviderSourceSnapshot(root)).workspaceHash || !current.confirmation || ["blocked", "cancelled"].includes(latest.status)) throw new Error("Current usable preparation and confirmed requirements are required.");
      current.degradedDecision = { sourceGeneration: preparation.sourceGeneration, eventHash: digest(response), acceptedAt: new Date().toISOString() };
    } else current.confirmation = { source: "operator-conversation", assurance: "conversational", ...session, eventHash: digest(response), quote: response, confirmedAt: new Date().toISOString(), revisionHash: task.revisionHash };
    await atomic(taskPath(root, taskId), current);
    await atomic(bindingPath(root, session.host, session.sessionId), { taskId, projectRoot: current.projectRoot });
    return current;
  }, { name: ".task-contract.lock" });
}
export async function recordTaskChangeMapping(root: string, taskId: string, entries: NonNullable<TaskDecisionReceipt["changeMapping"]>) {
  return withLock(root, async () => {
    const task = await loadTask(root, taskId); if (!task?.confirmation) throw new Error("Confirmed task required.");
    for (const entry of entries) {
      if (!task.contract.acceptanceCriteria.includes(entry.criterion) || !entry.rationale?.trim() || !strings(entry.files, "files", true).length || !strings(entry.tests, "tests", true).length) throw new Error("Mapping needs a known criterion, changed files, tests/checks and rationale.");
      const readiness = await checkTaskReadiness(root, { taskId, stage: "requirements", files: entry.files });
      if (!readiness.ready) throw new Error(readiness.blockers.join(" "));
    }
    if (task.contract.acceptanceCriteria.some(criterion => !entries.some(entry => entry.criterion === criterion))) throw new Error("Every acceptance criterion needs a change and test mapping.");
    task.changeMapping = entries; await atomic(taskPath(root, taskId), task); return task;
  }, { name: ".task-contract.lock" });
}

/** Claude's documented PostToolUse response carries the real native answer. */
export async function observeNativeQuestionResponse(root: string, host: string, sessionId: string, questions: unknown, response: unknown) {
  if (host !== 'claude-code' || !Array.isArray(questions) || !response || typeof response !== 'object') return { confirmed: false };
  const answers = (response as { answers?: Record<string, string> }).answers;
  if (!answers || typeof answers !== 'object') return { confirmed: false };
  return withLock(root, async () => {
    const task = await resolveSessionTask(root, host, sessionId); if (!task || task.contract.questions.some(question => !question.answer)) return { confirmed: false };
    const challenge = confirmationChallenge(task);
    for (const question of questions) {
      if (!question || typeof question.question !== 'string' || !question.question.includes(challenge) || !Array.isArray(question.options)) continue;
      const answer = answers[question.question];
      if (!['Approve scope', 'Confirm scope'].includes(answer) || !question.options.some((option: any) => option.label === answer)) continue;
      const quote = `${question.question}\nAnswer: ${answer}`;
      task.confirmation = { source: 'host-question-response', assurance: 'host-observed', host, sessionId, quote, eventHash: digest(quote), confirmedAt: new Date().toISOString(), revisionHash: task.revisionHash };
      await atomic(taskPath(root, task.taskId), task); return { confirmed: true, taskId: task.taskId };
    }
    return { confirmed: false };
  }, { name: '.task-contract.lock' });
}
