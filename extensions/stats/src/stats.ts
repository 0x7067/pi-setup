import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

export interface UsageTotals {
  requests: number;
  errors: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteReported: number;
  cacheWriteUnreported: number;
  totalTokens: number;
  cost: number;
}

export interface Breakdown extends UsageTotals {
  key: string;
}

export type CacheWriteStatus =
  "reported" | "not-reported" | "none-recorded" | "unmetered";

export interface ProviderModelBreakdown extends Breakdown {
  provider: string;
  model: string;
  meteredRequests: number;
  cacheHits: number;
  coldStartMisses: number;
  midSessionMisses: number;
  recentRequests: number;
  recentCacheMisses: number;
  recentCacheReuse: number | null;
  cacheWriteStatus: CacheWriteStatus;
}

export interface PiStats {
  generatedAt: string;
  sessionFiles: number;
  malformedLines: number;
  totals: UsageTotals;
  cacheWriteStatus: CacheWriteStatus;
  byModel: Breakdown[];
  byProviderModel: ProviderModelBreakdown[];
  byProvider: Breakdown[];
  byProject: Breakdown[];
  byDay: Breakdown[];
}

interface Usage {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cacheWriteReported?: unknown;
  totalTokens?: unknown;
  cost?: { total?: unknown };
}

interface SessionEntry {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  message?: {
    role?: unknown;
    model?: unknown;
    provider?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    timestamp?: unknown;
    usage?: Usage;
  };
}

interface UsageRecord {
  stableId: string;
  session: string;
  sequence: number;
  timestamp: number | undefined;
  chronology: number;
  hasUsage: boolean;
  cacheWriteReported: boolean;
  hadPriorMeteredUsage: boolean;
  project: string;
  model: string;
  provider: string;
  day: string;
  value: UsageTotals;
}

interface ParsedSession {
  file: string;
  startedAt: number;
  malformedLines: number;
  records: UsageRecord[];
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    errors: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWriteReported: 0,
    cacheWriteUnreported: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function add(target: UsageTotals, source: UsageTotals) {
  for (const key of Object.keys(target) as (keyof UsageTotals)[]) {
    target[key] += source[key];
  }
}

function breakdown(
  map: Map<string, UsageTotals>,
  key: string,
  value: UsageTotals,
) {
  const totals = map.get(key) ?? emptyTotals();
  add(totals, value);
  map.set(key, totals);
}

function sorted(map: Map<string, UsageTotals>, chronological = false) {
  return [...map.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) =>
      chronological
        ? left.key.localeCompare(right.key)
        : right.cost - left.cost ||
          right.requests - left.requests ||
          left.key.localeCompare(right.key),
    );
}

function cacheWriteStatus(
  totals: UsageTotals,
  usageRequests: number,
  cacheWriteReports: number,
): CacheWriteStatus {
  if (usageRequests === 0) return "unmetered";
  if (cacheWriteReports < usageRequests) return "not-reported";
  return totals.cacheWriteReported > 0 ? "reported" : "none-recorded";
}

function cacheWriteSummary(totals: UsageTotals, status: CacheWriteStatus) {
  const reported = `${totals.cacheWriteReported.toLocaleString()} cache-write tokens reported`;
  const unreported = `${totals.cacheWriteUnreported.toLocaleString()} cache-write tokens unreported`;
  if (status === "reported") return reported;
  if (status === "not-reported") {
    return totals.cacheWriteReported > 0
      ? `${reported}; ${totals.cacheWriteUnreported > 0 ? unreported : "additional writes not reported"}`
      : totals.cacheWriteUnreported > 0
        ? unreported
        : "Cache writes not reported by recorded providers";
  }
  return status === "none-recorded"
    ? "No cache writes recorded"
    : "Cache usage is unmetered";
}

function reusableInput(record: UsageRecord) {
  return (
    record.value.input +
    record.value.cacheRead +
    record.value.cacheWriteReported
  );
}

function providerModelBreakdown(
  totals: Map<string, UsageTotals>,
  records: Map<string, UsageRecord[]>,
) {
  return [...totals.entries()]
    .map(([key, value]): ProviderModelBreakdown => {
      const modelRecords = records.get(key) ?? [];
      const usageRecords = modelRecords.filter((record) => record.hasUsage);
      const reusable = usageRecords.filter(
        (record) => reusableInput(record) > 0,
      );
      const misses = reusable.filter((record) => record.value.cacheRead === 0);
      const coldStartMisses = misses.filter(
        (record) => !record.hadPriorMeteredUsage,
      ).length;
      const midSessionMisses = misses.length - coldStartMisses;

      const recent = usageRecords
        .sort(
          (left, right) =>
            left.chronology - right.chronology ||
            left.session.localeCompare(right.session) ||
            left.sequence - right.sequence,
        )
        .slice(-20);
      const recentInput = recent.reduce(
        (sum, record) => sum + record.value.input,
        0,
      );
      const recentCacheRead = recent.reduce(
        (sum, record) => sum + record.value.cacheRead,
        0,
      );
      const recentCacheWrite = recent.reduce(
        (sum, record) => sum + record.value.cacheWriteReported,
        0,
      );
      const recentReusable = recentInput + recentCacheRead + recentCacheWrite;
      const [provider, model] = JSON.parse(key) as [string, string];
      return {
        key: `${provider}/${model}`,
        provider,
        model,
        ...value,
        meteredRequests: usageRecords.length,
        cacheHits: reusable.filter((record) => record.value.cacheRead > 0)
          .length,
        coldStartMisses,
        midSessionMisses,
        recentRequests: recent.length,
        recentCacheMisses: recent.filter(
          (record) => reusableInput(record) > 0 && record.value.cacheRead === 0,
        ).length,
        recentCacheReuse:
          recentReusable > 0 ? recentCacheRead / recentReusable : null,
        cacheWriteStatus: cacheWriteStatus(
          value,
          usageRecords.length,
          usageRecords.filter((record) => record.cacheWriteReported).length,
        ),
      };
    })
    .sort(
      (left, right) =>
        right.cost - left.cost ||
        right.requests - left.requests ||
        left.key.localeCompare(right.key),
    );
}

async function sessionFiles(root: string) {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl"))
          files.push(path);
      }),
    );
  };
  await visit(root);
  return files.sort();
}

function messageTotals(entry: SessionEntry): UsageTotals | undefined {
  const message = entry.message;
  if (entry.type !== "message" || message?.role !== "assistant") return;
  const usage = message.usage;
  const cacheWrite = number(usage?.cacheWrite);
  const cacheWriteReported = usage?.cacheWriteReported === true;
  return {
    requests: 1,
    errors:
      message.stopReason === "error" || typeof message.errorMessage === "string"
        ? 1
        : 0,
    input: number(usage?.input),
    output: number(usage?.output),
    reasoning: number(usage?.reasoning),
    cacheRead: number(usage?.cacheRead),
    cacheWrite,
    cacheWriteReported: cacheWriteReported ? cacheWrite : 0,
    cacheWriteUnreported: cacheWriteReported ? 0 : cacheWrite,
    totalTokens: number(usage?.totalTokens),
    cost: number(usage?.cost?.total),
  };
}

function validTimestamp(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

async function parseSession(file: string): Promise<ParsedSession> {
  let project = basename(file, ".jsonl");
  let startedAt = Number.POSITIVE_INFINITY;
  let malformedLines = 0;
  let lineNumber = 0;
  const records: UsageRecord[] = [];
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      malformedLines += 1;
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.cwd === "string")
        project = basename(entry.cwd) || entry.cwd;
      const sessionTimestamp = validTimestamp(entry.timestamp);
      if (sessionTimestamp) startedAt = new Date(sessionTimestamp).getTime();
      continue;
    }
    const value = messageTotals(entry);
    if (!value) continue;

    const message = entry.message ?? {};
    const model = typeof message.model === "string" ? message.model : "unknown";
    const provider =
      typeof message.provider === "string" ? message.provider : "unknown";
    const rawTimestamp = message.timestamp ?? entry.timestamp;
    const timestamp = validTimestamp(rawTimestamp);
    const timestampMs = timestamp ? new Date(timestamp).getTime() : undefined;
    const cacheWriteReported = message.usage?.cacheWriteReported === true;
    const day = /^\d{4}-\d{2}-\d{2}/.exec(timestamp)?.[0] ?? "unknown";
    const stableId =
      typeof entry.id === "string"
        ? `id:${entry.id}:${JSON.stringify([
            rawTimestamp,
            model,
            provider,
            value.input,
            value.output,
            value.reasoning,
            value.cacheRead,
            value.cacheWrite,
            value.totalTokens,
            value.cost,
          ])}`
        : `fallback:${file}:${lineNumber}`;
    records.push({
      stableId,
      session: file,
      sequence: lineNumber,
      timestamp: timestampMs,
      chronology: 0,
      hasUsage: message.usage !== undefined && message.usage !== null,
      cacheWriteReported,
      hadPriorMeteredUsage: false,
      project,
      model,
      provider,
      day,
      value,
    });
  }

  let chronology = Number.NEGATIVE_INFINITY;
  const fallbackTimestamp = Number.isFinite(startedAt) ? startedAt : 0;
  const meteredProviderModels = new Set<string>();
  for (const record of records) {
    chronology = Math.max(chronology, record.timestamp ?? fallbackTimestamp);
    record.chronology = chronology;
    const providerModel = JSON.stringify([record.provider, record.model]);
    record.hadPriorMeteredUsage = meteredProviderModels.has(providerModel);
    if (reusableInput(record) > 0) meteredProviderModels.add(providerModel);
  }

  return { file, startedAt, malformedLines, records };
}

export async function collectStats(root: string): Promise<PiStats> {
  const files = await sessionFiles(root);
  const totals = emptyTotals();
  const byModel = new Map<string, UsageTotals>();
  const byProviderModel = new Map<string, UsageTotals>();
  const providerModelRecords = new Map<string, UsageRecord[]>();
  const byProvider = new Map<string, UsageTotals>();
  const byProject = new Map<string, UsageTotals>();
  const byDay = new Map<string, UsageTotals>();
  const seen = new Map<string, UsageRecord>();
  const retained: UsageRecord[] = [];
  let usageRequests = 0;
  let cacheWriteReports = 0;
  const sessions = await Promise.all(files.map(parseSession));
  sessions.sort(
    (left, right) =>
      left.startedAt - right.startedAt || left.file.localeCompare(right.file),
  );
  const malformedLines = sessions.reduce(
    (sum, session) => sum + session.malformedLines,
    0,
  );

  for (const session of sessions) {
    for (const record of session.records) {
      const existing = seen.get(record.stableId);
      if (existing) {
        if (!existing.hasUsage && record.hasUsage) existing.hasUsage = true;
        if (!existing.cacheWriteReported && record.cacheWriteReported) {
          existing.cacheWriteReported = true;
          existing.value.cacheWriteReported = existing.value.cacheWrite;
          existing.value.cacheWriteUnreported = 0;
        }
        continue;
      }
      seen.set(record.stableId, record);
      retained.push(record);
    }
  }

  for (const record of retained) {
    if (record.hasUsage) usageRequests += 1;
    if (record.hasUsage && record.cacheWriteReported) cacheWriteReports += 1;
    add(totals, record.value);
    breakdown(byModel, record.model, record.value);
    const providerModelKey = JSON.stringify([record.provider, record.model]);
    breakdown(byProviderModel, providerModelKey, record.value);
    const diagnosticRecords = providerModelRecords.get(providerModelKey) ?? [];
    diagnosticRecords.push(record);
    providerModelRecords.set(providerModelKey, diagnosticRecords);
    breakdown(byProvider, record.provider, record.value);
    breakdown(byProject, record.project, record.value);
    breakdown(byDay, record.day, record.value);
  }

  return {
    generatedAt: new Date().toISOString(),
    sessionFiles: files.length,
    malformedLines,
    totals,
    cacheWriteStatus: cacheWriteStatus(
      totals,
      usageRequests,
      cacheWriteReports,
    ),
    byModel: sorted(byModel),
    byProviderModel: providerModelBreakdown(
      byProviderModel,
      providerModelRecords,
    ),
    byProvider: sorted(byProvider),
    byProject: sorted(byProject),
    byDay: sorted(byDay, true),
  };
}

export function formatSummary(stats: PiStats) {
  const reusable =
    stats.totals.input +
    stats.totals.cacheRead +
    stats.totals.cacheWriteReported;
  const cacheRate =
    reusable > 0 ? (stats.totals.cacheRead / reusable) * 100 : 0;
  const errorRate =
    stats.totals.requests > 0
      ? (stats.totals.errors / stats.totals.requests) * 100
      : 0;
  return [
    `${stats.totals.requests.toLocaleString()} requests across ${stats.sessionFiles.toLocaleString()} session files`,
    `$${stats.totals.cost.toFixed(2)} total cost`,
    `${stats.totals.totalTokens.toLocaleString()} tokens (${stats.totals.output.toLocaleString()} output, ${stats.totals.reasoning.toLocaleString()} reasoning)`,
    `${cacheRate.toFixed(1)}% cache reuse`,
    cacheWriteSummary(stats.totals, stats.cacheWriteStatus),
    `${errorRate.toFixed(1)}% errors`,
    stats.malformedLines > 0
      ? `${stats.malformedLines} malformed JSONL lines skipped`
      : "No malformed JSONL lines",
  ].join("\n");
}
