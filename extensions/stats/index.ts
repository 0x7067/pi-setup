import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { StatsServer } from "./src/server.ts";
import {
  evaluateCacheGuard,
  formatPromptProfile,
  profileProviderPayload,
  type CacheGuardResult,
  type PromptProfile,
} from "./src/prompt-profile.ts";
import { collectStats, formatSummary } from "./src/stats.ts";
import {
  isWarningMode,
  loadStatsWarningConfig,
  privateConfigPath,
  saveStatsWarningConfig,
  WARNING_MODES,
} from "./src/warning-config.ts";

const noParameters = Type.Object({});

type CacheWriteUsage = {
  cacheWriteReported?: boolean;
};

export function recordCacheWriteProvenance(event: { message: AgentMessage }) {
  if (event.message.role !== "assistant") return;
  const usage = event.message.usage as typeof event.message.usage &
    CacheWriteUsage;
  if (typeof usage.cacheWriteReported !== "boolean") return;
  return {
    message: {
      ...event.message,
      usage: { ...usage, cacheWriteReported: usage.cacheWriteReported },
    },
  };
}

function sessionDirectory() {
  return (
    process.env.PI_STATS_SESSIONS_DIR ??
    join(getAgentDir(), "sessions")
  );
}

function configuredPort() {
  const value = Number(process.env.PI_STATS_PORT ?? 3847);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("PI_STATS_PORT must be an integer from 0 to 65535");
  }
  return value;
}

export default function statsExtension(rawPi: ExtensionAPI) {
  const pi = rawPi;
  let server: StatsServer | undefined;
  let starting: Promise<StatsServer> | undefined;
  let shuttingDown = false;
  const warningConfigPath = privateConfigPath();
  const previousProfiles = new Map<string, PromptProfile>();
  let pendingProfile:
    | {
        profile: PromptProfile;
        providerModel: string;
        stableWithPrevious: boolean;
      }
    | undefined;
  let lastProfile: PromptProfile | undefined;
  let lastCache: CacheGuardResult | undefined;
  const seenProviderModels = new Set<string>();
  const providerModelRequests = new Map<string, number>();
  const observedCacheModels = new Set<string>();
  const warnedStablePayloads = new Set<string>();
  let warningMode = loadStatsWarningConfig(warningConfigPath).warningMode;
  let consecutiveWarning:
    | {
        warningKey: string;
        turns: number;
      }
    | undefined;

  pi.on("session_start", () => {
    previousProfiles.clear();
    pendingProfile = undefined;
    lastProfile = undefined;
    lastCache = undefined;
    seenProviderModels.clear();
    providerModelRequests.clear();
    observedCacheModels.clear();
    warnedStablePayloads.clear();
    warningMode = loadStatsWarningConfig(warningConfigPath).warningMode;
    consecutiveWarning = undefined;
  });

  pi.on("message_end", recordCacheWriteProvenance);

  pi.on("before_provider_request", (event, ctx) => {
    const profile = profileProviderPayload(event.payload);
    const providerModel = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : `payload/${String(
          (event.payload as { model?: unknown } | undefined)?.model ??
            "unknown",
        )}`;
    pendingProfile = {
      profile,
      providerModel,
      stableWithPrevious:
        previousProfiles.get(providerModel)?.stableHash === profile.stableHash,
    };
    previousProfiles.set(providerModel, profile);
    lastProfile = profile;
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !pendingProfile) return;
    const message = event.message;
    const providerModel = `${message.provider}/${message.model}`;
    const reportedCache =
      message.usage.cacheRead > 0 ||
      (message.usage as CacheWriteUsage).cacheWriteReported === true;
    if (reportedCache) observedCacheModels.add(providerModel);
    const requestCount = (providerModelRequests.get(providerModel) ?? 0) + 1;
    providerModelRequests.set(providerModel, requestCount);
    const supportsCache =
      (ctx.model?.cost.cacheRead ?? 0) > 0 ||
      observedCacheModels.has(providerModel);
    const cache = evaluateCacheGuard(message.usage, {
      hadPriorRequest: seenProviderModels.has(providerModel),
      stablePayload:
        pendingProfile.providerModel === providerModel &&
        pendingProfile.stableWithPrevious,
      supportsCache,
    });
    if (cache.reusableTokens > 0) seenProviderModels.add(providerModel);
    lastProfile = pendingProfile.profile;
    lastCache = cache;
    pendingProfile = undefined;

    const warningKey = `${providerModel}:${lastProfile.stableHash}`;
    if (cache.status === "healthy") warnedStablePayloads.delete(warningKey);
    if (cache.status === "warning") {
      consecutiveWarning = {
        warningKey,
        turns:
          consecutiveWarning?.warningKey === warningKey
            ? consecutiveWarning.turns + 1
            : 1,
      };
    } else {
      consecutiveWarning = undefined;
    }
    const actionableWarning =
      warningMode === "all" ||
      ((consecutiveWarning?.turns ?? 0) >= 2 &&
        (cache.reusableTokens >= 20_000 || requestCount >= 3));
    if (
      cache.status === "warning" &&
      actionableWarning &&
      !warnedStablePayloads.has(warningKey) &&
      ctx.hasUI
    ) {
      warnedStablePayloads.add(warningKey);
      ctx.ui.notify(
        `Prompt cache regression for ${providerModel}: ${formatPromptProfile(lastProfile, cache)}`,
        "warning",
      );
    }
  });

  async function dashboard() {
    if (shuttingDown) throw new Error("Pi Stats is shutting down");
    if (server) return server;
    if (starting) return await starting;
    const candidate = new StatsServer(
      randomBytes(24).toString("base64url"),
      sessionDirectory(),
      configuredPort(),
    );
    starting = candidate
      .start()
      .then(() => {
        if (shuttingDown) throw new Error("Pi Stats is shutting down");
        server = candidate;
        return candidate;
      })
      .catch(async (error) => {
        await candidate.close();
        throw error;
      });
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }

  pi.registerCommand("stats", {
    description: "Show a local Pi usage summary or start the private dashboard",
    getArgumentCompletions: (prefix) => {
      const options = ["dashboard", "summary", "prompt"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return options.length > 0 ? options : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "dashboard";
      if (action === "summary") {
        ctx.ui.notify(
          formatSummary(await collectStats(sessionDirectory())),
          "info",
        );
        return;
      }
      if (action === "prompt") {
        ctx.ui.notify(
          lastProfile
            ? formatPromptProfile(lastProfile, lastCache)
            : "No provider request has been profiled in this session yet",
          "info",
        );
        return;
      }
      if (action !== "dashboard") {
        ctx.ui.notify("Usage: /stats [dashboard|summary|prompt]", "error");
        return;
      }
      const running = await dashboard();
      ctx.ui.notify(
        `Pi Stats is available while this Pi session is open:\n${running.url}`,
        "info",
      );
    },
  });

  pi.registerCommand("stats-warnings", {
    description: "Configure stats regression warning notifications",
    getArgumentCompletions: (prefix) => {
      const options = WARNING_MODES.filter((value) =>
        value.startsWith(prefix),
      ).map((value) => ({ value, label: value }));
      return options.length > 0 ? options : null;
    },
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (!mode) {
        ctx.ui.notify(`Stats warning mode: ${warningMode}`, "info");
        return;
      }
      if (!isWarningMode(mode)) {
        ctx.ui.notify("Usage: /stats-warnings [all|actionable]", "error");
        return;
      }
      await saveStatsWarningConfig({ warningMode: mode }, warningConfigPath);
      warningMode = mode;
      ctx.ui.notify(`Stats warning mode set to ${warningMode}`, "info");
    },
  });

  pi.registerTool({
    name: "pi-stats",
    label: "Pi Stats",
    description:
      "Return a read-only aggregate of local Pi session usage, including requests, tokens, cost, cache reuse, errors, models, providers, projects, and days.",
    promptSnippet: "Summarize local Pi model usage and cost",
    parameters: noParameters,
    async execute() {
      const stats = await collectStats(sessionDirectory());
      return {
        content: [
          {
            type: "text" as const,
            text: `${formatSummary(stats)}\n\n${JSON.stringify(
              {
                byModel: stats.byModel,
                byProviderModel: stats.byProviderModel,
                byProvider: stats.byProvider,
                byProject: stats.byProject,
                byDay: stats.byDay,
              },
              null,
              2,
            )}`,
          },
        ],
        details: { generatedAt: stats.generatedAt },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const pending = starting;
    const running = server;
    server = undefined;
    await pending?.catch(() => undefined);
    await running?.close();
  });
}
