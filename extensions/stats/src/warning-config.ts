import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const WARNING_MODES = ["all", "actionable"] as const;

export type WarningMode = (typeof WARNING_MODES)[number];

export interface StatsWarningConfig {
  readonly warningMode: WarningMode;
}

export const DEFAULT_WARNING_CONFIG: StatsWarningConfig = {
  warningMode: "all",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isWarningMode = (value: unknown): value is WarningMode =>
  typeof value === "string" && WARNING_MODES.includes(value as WarningMode);

export function privateConfigPath() {
  return process.env.PI_STATS_CONFIG_PATH ?? join(getAgentDir(), "config", "stats-warnings.json");
}

export function parseStatsWarningConfig(value: unknown): StatsWarningConfig {
  if (!isRecord(value) || !isWarningMode(value.warningMode)) {
    return DEFAULT_WARNING_CONFIG;
  }
  return { warningMode: value.warningMode };
}

export function loadStatsWarningConfig(path = privateConfigPath()) {
  try {
    return parseStatsWarningConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_WARNING_CONFIG;
  }
}

export async function saveStatsWarningConfig(
  config: StatsWarningConfig,
  path = privateConfigPath(),
) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
