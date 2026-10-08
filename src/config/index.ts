import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const GW_CONFIG_PATH = ".graphward/gw.config.json";
export const LEGACY_CONFIG_PATH = ".graphward/config.json";
export const GW_CONFIG_SCHEMA_VERSION = 2;

export type ProviderPolicy = "auto" | "full" | "native";

export interface ProjectFilesConfig {
  roots?: string[];
  include?: string[];
  exclude?: string[];
}

export interface ProvidersConfig {
  policy?: ProviderPolicy;
  offline?: boolean;
  requireProviders?: boolean;
  exposeRawMcp?: boolean;
}

export type RoutingLogLevel = "none" | "summary" | "verbose";

export type CostTier = "cheap" | "standard" | "premium";

export interface CapabilityCard {
  id: string;
  model: string;
  description: string;
  strengths: string[];
  costTier: CostTier;
  contextWindow?: number;
}

export interface RoutingConfig {
  enabled: boolean;
  threshold: number;
  classifier: string;
  capabilityCards: CapabilityCard[];
  logLevel: RoutingLogLevel;
  forceModel?: string;
}

export interface GwConfig {
  schemaVersion: number;
  hooks?: Record<string, unknown>;
  tokenBudgets: Record<string, number>;
  projectFiles: ProjectFilesConfig;
  providers: ProvidersConfig;
  routing: RoutingConfig;
  negativeConstraintTTLDays?: number;
  clarityThreshold?: number;
  [key: string]: unknown;
}

export type EiConfig = GwConfig;

export const DEFAULT_CAPABILITY_CARDS: CapabilityCard[] = [
  {
    id: "card-cheap",
    model: "gpt-4o-mini",
    description: "Fast lightweight model for formatting, syntax checks, and simple unit tests",
    strengths: ["formatting", "syntax", "quick-fixes", "comments", "unit-tests"],
    costTier: "cheap",
    contextWindow: 128000,
  },
  {
    id: "card-premium",
    model: "gpt-4o",
    description: "High-reasoning model for complex architecture, distributed systems, and refactoring",
    strengths: ["architecture", "refactoring", "distributed-systems", "complex-debugging", "consensus"],
    costTier: "premium",
    contextWindow: 128000,
  },
];

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: true,
  threshold: 0.7,
  classifier: "gpt-4o-mini",
  capabilityCards: DEFAULT_CAPABILITY_CARDS,
  logLevel: "summary",
};

export const DEFAULT_CONFIG: GwConfig = {
  schemaVersion: GW_CONFIG_SCHEMA_VERSION,
  hooks: {},
  tokenBudgets: {},
  projectFiles: {},
  providers: {
    policy: "auto",
    offline: false,
    requireProviders: false,
    exposeRawMcp: false,
  },
  routing: DEFAULT_ROUTING_CONFIG,
};

const writeQueues = new Map<string, Promise<unknown>>();

export function serializeConfigWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = writeQueues.get(key);

  const current = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Suppress previous error: handled by its own caller
      }
    }
    return await task();
  })();

  const tail = current.then(
    () => {},
    () => {},
  );
  writeQueues.set(key, tail);

  tail.then(() => {
    if (writeQueues.get(key) === tail) {
      writeQueues.delete(key);
    }
  });

  return current;
}

export async function writeAtomic(targetPath: string, content: string): Promise<void> {
  const temporary = `${targetPath}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, targetPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson(location: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(location, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function numbers(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0),
  );
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  return result.length > 0 ? result : undefined;
}

function normalizeCapabilityCard(card: unknown, index: number): CapabilityCard | undefined {
  if (!card || typeof card !== "object" || Array.isArray(card)) return undefined;
  const c = card as Record<string, unknown>;
  const id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : `card-${index}`;
  const model = typeof c.model === "string" && c.model.trim() ? c.model.trim() : "";
  if (!model) return undefined;
  const description = typeof c.description === "string" ? c.description.trim() : "";
  const strengths = Array.isArray(c.strengths)
    ? c.strengths.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean)
    : [];
  const validTiers: CostTier[] = ["cheap", "standard", "premium"];
  const costTier: CostTier = typeof c.costTier === "string" && validTiers.includes(c.costTier as CostTier)
    ? (c.costTier as CostTier)
    : "standard";
  const contextWindow = typeof c.contextWindow === "number" && Number.isFinite(c.contextWindow) && c.contextWindow >= 0
    ? c.contextWindow
    : undefined;
  return {
    id,
    model,
    description,
    strengths,
    costTier,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function normalizeCapabilityCards(cards: unknown): CapabilityCard[] {
  if (!Array.isArray(cards)) return DEFAULT_CAPABILITY_CARDS;
  const normalized = cards
    .map((card, i) => normalizeCapabilityCard(card, i))
    .filter((card): card is CapabilityCard => Boolean(card));
  return normalized.length > 0 ? normalized : DEFAULT_CAPABILITY_CARDS;
}

export function normalizeRoutingConfig(raw?: unknown, env: NodeJS.ProcessEnv = process.env): RoutingConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

  let enabled = typeof source.enabled === "boolean" ? source.enabled : DEFAULT_ROUTING_CONFIG.enabled;
  if (env?.CODEX_SHIM_DISABLE_ROUTER !== undefined && env.CODEX_SHIM_DISABLE_ROUTER.trim() !== "") {
    const disableVal = env.CODEX_SHIM_DISABLE_ROUTER.trim().toLowerCase();
    if (disableVal === "1" || disableVal === "true" || disableVal === "yes" || disableVal === "on") {
      enabled = false;
    } else if (disableVal === "0" || disableVal === "false" || disableVal === "no" || disableVal === "off") {
      enabled = true;
    }
  }

  let threshold = typeof source.threshold === "number" && Number.isFinite(source.threshold)
    ? Math.max(0.0, Math.min(1.0, source.threshold))
    : DEFAULT_ROUTING_CONFIG.threshold;
  if (env?.CODEX_SHIM_THRESHOLD !== undefined && env.CODEX_SHIM_THRESHOLD.trim() !== "") {
    const envThreshold = Number(env.CODEX_SHIM_THRESHOLD.trim());
    if (Number.isFinite(envThreshold)) {
      if (envThreshold >= 0.0 && envThreshold <= 1.0) {
        threshold = envThreshold;
      } else {
        threshold = DEFAULT_ROUTING_CONFIG.threshold;
      }
    }
  }

  const validLevels: RoutingLogLevel[] = ["none", "summary", "verbose"];
  let logLevel: RoutingLogLevel = typeof source.logLevel === "string" && validLevels.includes(source.logLevel as RoutingLogLevel)
    ? (source.logLevel as RoutingLogLevel)
    : DEFAULT_ROUTING_CONFIG.logLevel;
  if (env?.CODEX_SHIM_ROUTER_LOG !== undefined && env.CODEX_SHIM_ROUTER_LOG.trim() !== "") {
    const envLog = env.CODEX_SHIM_ROUTER_LOG.trim().toLowerCase();
    if (envLog === "verbose") {
      logLevel = "verbose";
    } else if (envLog === "summary") {
      logLevel = "summary";
    } else if (envLog === "none" || envLog === "0" || envLog === "false") {
      logLevel = "none";
    } else if (envLog === "1" || envLog === "true") {
      logLevel = logLevel === "none" ? "summary" : logLevel;
    }
  }

  let forceModel: string | undefined = typeof source.forceModel === "string" && source.forceModel.trim() !== ""
    ? source.forceModel.trim()
    : undefined;
  if (env?.CODEX_SHIM_FORCE_MODEL !== undefined) {
    const envForce = env.CODEX_SHIM_FORCE_MODEL.trim();
    forceModel = envForce !== "" ? envForce : undefined;
  }

  const classifier = typeof source.classifier === "string" && source.classifier.trim() !== ""
    ? source.classifier.trim()
    : DEFAULT_ROUTING_CONFIG.classifier;

  const capabilityCards = normalizeCapabilityCards(source.capabilityCards);

  return {
    enabled,
    threshold,
    classifier,
    capabilityCards,
    logLevel,
    ...(forceModel ? { forceModel } : {}),
  };
}

export function normalizeConfig(
  raw: Record<string, unknown>,
  legacy: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): GwConfig {
  const projectFiles = raw.projectFiles && typeof raw.projectFiles === "object" && !Array.isArray(raw.projectFiles)
    ? raw.projectFiles as Record<string, unknown>
    : {};
  const providers = raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers)
    ? raw.providers as Record<string, unknown>
    : {};
  const rawPolicy = providers.policy;
  const policy: ProviderPolicy = rawPolicy === "full" || rawPolicy === "native" ? rawPolicy : "auto";
  // Provider installation is optional by default for every policy. `full`
  // selects the provider-backed path; `--require-providers` is the explicit
  // opt-in that turns a missing/unhealthy provider into a hard failure.
  const requireProviders = providers.requireProviders === true;
  return {
    ...raw,
    schemaVersion: GW_CONFIG_SCHEMA_VERSION,
    hooks: raw.hooks && typeof raw.hooks === "object" && !Array.isArray(raw.hooks)
      ? raw.hooks as Record<string, unknown>
      : {},
    tokenBudgets: {
      ...numbers(legacy.tokenBudgets),
      ...numbers(raw.tokenBudgets),
    },
    projectFiles: {
      roots: strings(projectFiles.roots),
      include: strings(projectFiles.include),
      exclude: strings(projectFiles.exclude),
    },
    providers: {
      policy,
      offline: providers.offline === true,
      requireProviders,
      exposeRawMcp: providers.exposeRawMcp === true,
    },
    routing: normalizeRoutingConfig(raw.routing, env),
  };
}

export async function loadGwConfig(root: string, env: NodeJS.ProcessEnv = process.env): Promise<GwConfig> {
  const [raw, legacy] = await Promise.all([
    readJson(path.join(root, GW_CONFIG_PATH)),
    readJson(path.join(root, LEGACY_CONFIG_PATH)),
  ]);
  return normalizeConfig(raw ?? DEFAULT_CONFIG, legacy, env);
}
export const loadEiConfig = loadGwConfig;

export function defaultGwConfig(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): GwConfig {
  return normalizeConfig({ ...DEFAULT_CONFIG, ...overrides }, {}, env);
}
export const defaultEiConfig = defaultGwConfig;

/**
 * Consolidate the legacy token-budget file into gw.config.json. The write is
 * atomic and unknown user keys are preserved. The legacy file is deliberately
 * not deleted: removing user-owned configuration needs an explicit cleanup.
 */
export async function migrateGwConfig(root: string): Promise<{ changed: boolean; path: string; config: GwConfig }> {
  const configPath = path.join(root, GW_CONFIG_PATH);
  return serializeConfigWrite(configPath, async () => {
    const [raw, legacy] = await Promise.all([readJson(configPath), readJson(path.join(root, LEGACY_CONFIG_PATH))]);
    const config = normalizeConfig(raw ?? DEFAULT_CONFIG, legacy, {});
    const current = raw ? `${JSON.stringify(raw, null, 2)}\n` : undefined;
    const desired = `${JSON.stringify(config, null, 2)}\n`;
    if (current === desired) return { changed: false, path: GW_CONFIG_PATH, config };
    await writeAtomic(configPath, desired);
    return { changed: true, path: GW_CONFIG_PATH, config };
  });
}
export const migrateEiConfig = migrateGwConfig;

export async function setProviderExpertMode(root: string, enabled: boolean): Promise<GwConfig> {
  return updateProviderConfig(root, { exposeRawMcp: enabled });
}

export async function updateProviderConfig(root: string, patch: Partial<ProvidersConfig>): Promise<GwConfig> {
  const configPath = path.join(root, GW_CONFIG_PATH);
  return serializeConfigWrite(configPath, async () => {
    const [raw, legacy] = await Promise.all([readJson(configPath), readJson(path.join(root, LEGACY_CONFIG_PATH))]);
    const config = normalizeConfig(raw ?? DEFAULT_CONFIG, legacy, {});
    const updated: GwConfig = { ...config, providers: { ...config.providers, ...patch } };
    await writeAtomic(configPath, `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  });
}

export async function updateRoutingConfig(root: string, patch: Partial<RoutingConfig>): Promise<RoutingConfig> {
  const configPath = path.join(root, GW_CONFIG_PATH);
  return serializeConfigWrite(configPath, async () => {
    const [raw, legacy] = await Promise.all([readJson(configPath), readJson(path.join(root, LEGACY_CONFIG_PATH))]);
    const fileConfig = normalizeConfig(raw ?? DEFAULT_CONFIG, legacy, {});
    const currentRouting = fileConfig.routing ?? DEFAULT_ROUTING_CONFIG;
    const patchedRouting = normalizeRoutingConfig({ ...currentRouting, ...patch }, {});
    const updatedConfig: GwConfig = {
      ...fileConfig,
      routing: patchedRouting,
    };
    await writeAtomic(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`);
    return patchedRouting;
  });
}
