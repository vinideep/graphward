import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const GW_CONFIG_PATH = ".graphward/gw.config.json";
export const LEGACY_CONFIG_PATH = ".graphward/config.json";
export const GW_CONFIG_SCHEMA_VERSION = 2;

export type ProviderPolicy = "auto" | "full" | "native";
export type WorkflowMode = "strict" | "concise";

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

export interface GwConfig {
  schemaVersion: number;
  workflow: { mode: WorkflowMode; [key: string]: unknown };
  hooks?: Record<string, unknown>;
  tokenBudgets: Record<string, number>;
  projectFiles: ProjectFilesConfig;
  providers: ProvidersConfig;
  negativeConstraintTTLDays?: number;
  clarityThreshold?: number;
  [key: string]: unknown;
}

export type EiConfig = GwConfig;

const DEFAULT_CONFIG: GwConfig = {
  schemaVersion: GW_CONFIG_SCHEMA_VERSION,
  workflow: { mode: "strict" },
  hooks: {},
  tokenBudgets: {},
  projectFiles: {},
  providers: {
    policy: "auto",
    offline: false,
    requireProviders: false,
    exposeRawMcp: false,
  },
};

async function readJson(location: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(location, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid or unreadable GraphWard configuration at ${location}; original bytes preserved. ${error instanceof Error ? error.message : String(error)}`);
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

function normalizeConfig(raw: Record<string, unknown>, legacy: Record<string, unknown> = {}): EiConfig {
  const workflow = raw.workflow && typeof raw.workflow === "object" && !Array.isArray(raw.workflow)
    ? raw.workflow as Record<string, unknown> : {};
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
    workflow: { ...workflow, mode: workflow.mode === "concise" ? "concise" : "strict" },
    hooks: {
      ...(raw.hooks && typeof raw.hooks === "object" && !Array.isArray(raw.hooks) ? raw.hooks as Record<string, unknown> : {}),
      unavailableValidationPolicy: (raw.hooks as Record<string, unknown> | undefined)?.unavailableValidationPolicy === "allow-explicit" ? "allow-explicit" : "block",
    },
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
  };
}

export async function loadGwConfig(root: string): Promise<GwConfig> {
  const [raw, legacy] = await Promise.all([
    readJson(path.join(root, GW_CONFIG_PATH)),
    readJson(path.join(root, LEGACY_CONFIG_PATH)),
  ]);
  return normalizeConfig(raw ?? DEFAULT_CONFIG, legacy);
}
export const loadEiConfig = loadGwConfig;

export function defaultGwConfig(overrides: Record<string, unknown> = {}): GwConfig {
  return normalizeConfig({ ...DEFAULT_CONFIG, ...overrides });
}
export const defaultEiConfig = defaultGwConfig;

/**
 * Consolidate the legacy token-budget file into gw.config.json. The write is
 * atomic and unknown user keys are preserved. The legacy file is deliberately
 * not deleted: removing user-owned configuration needs an explicit cleanup.
 */
export async function migrateGwConfig(root: string): Promise<{ changed: boolean; path: string; config: GwConfig }> {
  const configPath = path.join(root, GW_CONFIG_PATH);
  const [raw, legacy] = await Promise.all([readJson(configPath), readJson(path.join(root, LEGACY_CONFIG_PATH))]);
  const config = normalizeConfig(raw ?? DEFAULT_CONFIG, legacy);
  const current = raw ? `${JSON.stringify(raw, null, 2)}\n` : undefined;
  const desired = `${JSON.stringify(config, null, 2)}\n`;
  if (current === desired) return { changed: false, path: GW_CONFIG_PATH, config };
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp-${process.pid}`;
  await writeFile(temporary, desired, "utf8");
  await rename(temporary, configPath);
  return { changed: true, path: GW_CONFIG_PATH, config };
}
export const migrateEiConfig = migrateGwConfig;

export async function setProviderExpertMode(root: string, enabled: boolean): Promise<GwConfig> {
  return updateProviderConfig(root, { exposeRawMcp: enabled });
}

export async function updateProviderConfig(root: string, patch: Partial<ProvidersConfig>): Promise<GwConfig> {
  const config = await loadGwConfig(root);
  const updated: GwConfig = { ...config, providers: { ...config.providers, ...patch } };
  const configPath = path.join(root, GW_CONFIG_PATH);
  const temporary = `${configPath}.tmp-${process.pid}`;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await rename(temporary, configPath);
  return updated;
}
