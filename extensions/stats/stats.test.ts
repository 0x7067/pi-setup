import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordCacheWriteProvenance } from "./index.ts";
import { collectStats, formatSummary } from "./src/stats.ts";

const message = (
  id: string,
  timestamp: string,
  usage: {
    input: number;
    cacheRead: number;
    cacheWrite?: number;
    cacheWriteReported?: boolean;
  },
  provider = "openai-codex",
  model = "gpt-test",
) =>
  JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      provider,
      model,
      stopReason: "stop",
      usage: {
        input: usage.input,
        output: 1,
        cacheRead: usage.cacheRead,
        ...(usage.cacheWrite === undefined
          ? {}
          : { cacheWrite: usage.cacheWrite }),
        ...(usage.cacheWriteReported === undefined
          ? {}
          : { cacheWriteReported: usage.cacheWriteReported }),
        totalTokens:
          usage.input + usage.cacheRead + (usage.cacheWrite ?? 0) + 1,
        cost: { total: 0 },
      },
    },
  });

test("attributes forked usage to its origin and tolerates malformed timestamps", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-test-"));
  await mkdir(join(root, "project"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const session = ({
    entryId,
    cwd,
    startedAt,
    messageTimestamp = "2026-08-08T10:00:00.000Z",
  }: {
    entryId: string;
    cwd: string;
    startedAt: string;
    messageTimestamp?: string | number;
  }) => [
    JSON.stringify({
      type: "session",
      id: `session-${cwd}`,
      timestamp: startedAt,
      cwd,
    }),
    JSON.stringify({
      type: "message",
      id: entryId,
      timestamp: messageTimestamp,
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-test",
        stopReason: "stop",
        usage: {
          input: 100,
          output: 20,
          reasoning: 5,
          cacheRead: 80,
          cacheWrite: 0,
          cacheWriteReported: true,
          totalTokens: 205,
          cost: { total: 0.25 },
        },
      },
    }),
  ];

  await writeFile(
    join(root, "project", "source.jsonl"),
    `${session({ entryId: "shared", cwd: "/work/source", startedAt: "2026-08-08T09:00:00.000Z" }).join("\n")}\n{truncated`,
    "utf8",
  );
  await writeFile(
    join(root, "project", "fork.jsonl"),
    `${session({ entryId: "shared", cwd: "/work/fork", startedAt: "2026-08-08T11:00:00.000Z" }).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "project", "unique.jsonl"),
    `${session({ entryId: "unique", cwd: "/work/unique", startedAt: "2026-08-08T12:00:00.000Z" }).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "project", "collision.jsonl"),
    `${session({ entryId: "shared", cwd: "/work/collision", startedAt: "2026-08-08T13:00:00.000Z", messageTimestamp: "2026-08-08T10:05:00.000Z" }).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "project", "invalid-time.jsonl"),
    `${session({ entryId: "bad-time", cwd: "/work/invalid", startedAt: "2026-08-08T14:00:00.000Z", messageTimestamp: 1e99 }).join("\n")}\n`,
    "utf8",
  );

  const stats = await collectStats(root);
  assert.equal(stats.sessionFiles, 5);
  assert.equal(stats.malformedLines, 1);
  assert.equal(stats.totals.requests, 4);
  assert.equal(stats.totals.totalTokens, 820);
  assert.equal(stats.totals.cost, 1);
  assert.equal(stats.byModel[0]?.key, "gpt-test");
  assert.equal(
    stats.byProject.find((item) => item.key === "source")?.requests,
    1,
  );
  assert.equal(
    stats.byProject.some((item) => item.key === "fork"),
    false,
  );
  assert.equal(stats.byDay.find((item) => item.key === "unknown")?.requests, 1);
  assert.equal(stats.cacheWriteStatus, "none-recorded");
  assert.match(formatSummary(stats), /No cache writes recorded/);
  const providerModel = stats.byProviderModel[0];
  assert.equal(providerModel?.key, "openai-codex/gpt-test");
  assert.equal(providerModel?.meteredRequests, 4);
  assert.equal(providerModel?.cacheHits, 4);
  assert.equal(providerModel?.coldStartMisses, 0);
  assert.equal(providerModel?.midSessionMisses, 0);
  assert.equal(providerModel?.recentRequests, 4);
  assert.equal(providerModel?.recentCacheMisses, 0);
  assert.equal(providerModel?.cacheWriteStatus, "none-recorded");
});

test("separates cold and mid-session misses without inventing cache writes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-cache-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(
    join(root, "session-a.jsonl"),
    [
      JSON.stringify({
        type: "session",
        timestamp: "2026-08-08T09:00:00.000Z",
        cwd: "/work/a",
      }),
      message("a1", "2026-08-08T09:00:01.000Z", {
        input: 100,
        cacheRead: 0,
      }),
      message("a2", "2026-08-08T09:00:02.000Z", {
        input: 20,
        cacheRead: 80,
      }),
      message("a3", "2026-08-08T09:00:03.000Z", {
        input: 50,
        cacheRead: 0,
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(root, "session-b.jsonl"),
    [
      JSON.stringify({
        type: "session",
        timestamp: "2026-08-08T10:00:00.000Z",
        cwd: "/work/b",
      }),
      message("b1", "2026-08-08T10:00:01.000Z", {
        input: 10,
        cacheRead: 90,
      }),
      message(
        "b2",
        "2026-08-08T10:00:02.000Z",
        {
          input: 10,
          cacheRead: 0,
          cacheWrite: 100,
          cacheWriteReported: true,
        },
        "anthropic",
        "claude-test",
      ),
      message(
        "b3",
        "2026-08-08T10:00:03.000Z",
        { input: 100, cacheRead: 0 },
        "cohere",
        "command-test",
      ),
    ].join("\n") + "\n",
    "utf8",
  );

  const stats = await collectStats(root);
  const openai = stats.byProviderModel.find(
    (item) => item.key === "openai-codex/gpt-test",
  );
  assert.equal(openai?.meteredRequests, 4);
  assert.equal(openai?.cacheHits, 2);
  assert.equal(openai?.coldStartMisses, 1);
  assert.equal(openai?.midSessionMisses, 1);
  assert.equal(openai?.recentCacheMisses, 2);
  assert.equal(openai?.recentCacheReuse, 170 / 350);
  assert.equal(openai?.cacheWriteStatus, "not-reported");

  const anthropic = stats.byProviderModel.find(
    (item) => item.key === "anthropic/claude-test",
  );
  assert.equal(anthropic?.cacheWrite, 100);
  assert.equal(anthropic?.meteredRequests, 1);
  assert.equal(anthropic?.coldStartMisses, 1);
  assert.equal(anthropic?.recentRequests, 1);
  assert.equal(anthropic?.recentCacheReuse, 0);
  assert.equal(anthropic?.cacheWriteStatus, "reported");
  assert.equal(
    stats.byProviderModel.find((item) => item.key === "cohere/command-test")
      ?.cacheWriteStatus,
    "not-reported",
  );
  assert.equal(stats.cacheWriteStatus, "not-reported");
  assert.match(
    formatSummary(stats),
    /100 cache-write tokens reported; additional writes not reported/,
  );
});

test("uses persisted provenance instead of normalized cache-write zero", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-provenance-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "session.jsonl"),
    [
      message(
        "normalized-zero",
        "2026-08-08T09:00:01.000Z",
        { input: 20, cacheRead: 80, cacheWrite: 0 },
        "google",
        "gemini-test",
      ),
      message(
        "reported-zero",
        "2026-08-08T09:00:02.000Z",
        {
          input: 20,
          cacheRead: 80,
          cacheWrite: 0,
          cacheWriteReported: true,
        },
        "anthropic",
        "claude-test",
      ),
    ].join("\n") + "\n",
    "utf8",
  );

  const stats = await collectStats(root);
  assert.equal(
    stats.byProviderModel.find((item) => item.provider === "google")
      ?.cacheWriteStatus,
    "not-reported",
  );
  assert.equal(
    stats.byProviderModel.find((item) => item.provider === "anthropic")
      ?.cacheWriteStatus,
    "none-recorded",
  );
});

test("preserves only cache-write provenance supplied by the finalized message", () => {
  const assistant = (cacheWrite: number, cacheWriteReported?: boolean) => ({
    role: "assistant" as const,
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 20,
      output: 1,
      cacheRead: 80,
      cacheWrite,
      ...(cacheWriteReported === undefined ? {} : { cacheWriteReported }),
      totalTokens: 101 + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
  });

  assert.equal(
    recordCacheWriteProvenance({ message: assistant(0) }),
    undefined,
  );
  const exact = assistant(0, true);
  const exactTransformed = recordCacheWriteProvenance({ message: exact });
  assert.ok(exactTransformed);
  assert.equal(
    JSON.parse(JSON.stringify(exactTransformed.message)).usage
      .cacheWriteReported,
    true,
  );

  const explicitFalse = assistant(5, false);
  const explicitFalseTransformed = recordCacheWriteProvenance({
    message: explicitFalse,
  });
  assert.ok(explicitFalseTransformed);
  assert.equal(
    JSON.parse(JSON.stringify(explicitFalseTransformed.message)).usage
      .cacheWriteReported,
    false,
  );

  assert.equal(
    recordCacheWriteProvenance({ message: assistant(5) }),
    undefined,
  );

  const persisted = JSON.parse(
    JSON.stringify(explicitFalseTransformed.message),
  ) as {
    usage: { cacheWrite: number; cacheWriteReported?: boolean };
  };
  assert.equal(persisted.usage.cacheWrite, 5);
  assert.equal(persisted.usage.cacheWriteReported, false);
});

test("separates reported and unreported cache-write totals", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-cache-write-totals-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "session.jsonl"),
    [
      message(
        "reported",
        "2026-08-08T09:00:01.000Z",
        { input: 20, cacheRead: 80, cacheWrite: 100, cacheWriteReported: true },
        "provider",
        "model",
      ),
      message(
        "unknown",
        "2026-08-08T09:00:02.000Z",
        { input: 20, cacheRead: 80, cacheWrite: 7 },
        "provider",
        "model",
      ),
    ].join("\n") + "\n",
    "utf8",
  );

  const stats = await collectStats(root);
  const providerModel = stats.byProviderModel[0];
  assert.equal(stats.totals.cacheWrite, 107);
  assert.equal(stats.totals.cacheWriteReported, 100);
  assert.equal(stats.totals.cacheWriteUnreported, 7);
  assert.equal(providerModel?.cacheWrite, 107);
  assert.equal(providerModel?.cacheWriteReported, 100);
  assert.equal(providerModel?.cacheWriteUnreported, 7);
  assert.equal(providerModel?.cacheWriteStatus, "not-reported");
  assert.equal(providerModel?.recentCacheReuse, 160 / 300);
  assert.match(
    formatSummary(stats),
    /100 cache-write tokens reported; 7 cache-write tokens unreported/,
  );
});

test("keeps output-only usage in recent request chronology", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-output-only-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const entries = [
    JSON.stringify({
      type: "session",
      timestamp: "2026-08-08T09:00:00.000Z",
      cwd: "/work/output-only",
    }),
    ...Array.from({ length: 20 }, (_, index) =>
      message(
        `hit-${index}`,
        `2026-08-08T09:00:${String(index + 1).padStart(2, "0")}.000Z`,
        { input: 10, cacheRead: 90 },
      ),
    ),
    JSON.stringify({
      type: "message",
      id: "output-only",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-test",
        stopReason: "stop",
        usage: { output: 5, totalTokens: 5, cost: { total: 0 } },
      },
    }),
  ];
  await writeFile(
    join(root, "session.jsonl"),
    `${entries.join("\n")}\n`,
    "utf8",
  );

  const stats = await collectStats(root);
  const providerModel = stats.byProviderModel[0];
  assert.equal(providerModel?.recentRequests, 20);
  assert.equal(providerModel?.recentCacheMisses, 0);
  assert.equal(providerModel?.recentCacheReuse, 1710 / 1900);
});

test("keeps trailing untimestamped usage in the recent window", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-chronology-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const entries = [
    JSON.stringify({
      type: "session",
      timestamp: "2026-08-08T09:00:00.000Z",
      cwd: "/work/chronology",
    }),
    ...Array.from({ length: 20 }, (_, index) =>
      message(
        `hit-${index}`,
        `2026-08-08T09:00:${String(index + 1).padStart(2, "0")}.000Z`,
        { input: 10, cacheRead: 90 },
      ),
    ),
    JSON.stringify({
      type: "message",
      id: "untimestamped-miss",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-test",
        stopReason: "stop",
        usage: {
          input: 100,
          output: 1,
          cacheRead: 0,
          totalTokens: 101,
          cost: { total: 0 },
        },
      },
    }),
  ];
  await writeFile(
    join(root, "session.jsonl"),
    `${entries.join("\n")}\n`,
    "utf8",
  );

  const stats = await collectStats(root);
  assert.equal(stats.byProviderModel[0]?.recentRequests, 20);
  assert.equal(stats.byProviderModel[0]?.recentCacheMisses, 1);
});

test("keeps fork history when classifying a retained miss", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-fork-miss-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const shared = message("shared", "2026-08-08T09:00:01.000Z", {
    input: 20,
    cacheRead: 80,
  });
  await writeFile(join(root, "a-source.jsonl"), `${shared}\n`, "utf8");
  await writeFile(
    join(root, "b-fork.jsonl"),
    `${shared}\n${message("fork-miss", "2026-08-08T09:00:02.000Z", {
      input: 100,
      cacheRead: 0,
    })}\n`,
    "utf8",
  );

  const stats = await collectStats(root);
  assert.equal(stats.totals.requests, 2);
  assert.equal(stats.byProviderModel[0]?.coldStartMisses, 0);
  assert.equal(stats.byProviderModel[0]?.midSessionMisses, 1);
});

test("labels an archive with only unmetered responses as unmetered", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-unmetered-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "session.jsonl"),
    `${JSON.stringify({
      type: "message",
      id: "error",
      message: {
        role: "assistant",
        provider: "cursor",
        model: "composer-test",
        stopReason: "error",
      },
    })}\n`,
    "utf8",
  );

  const stats = await collectStats(root);
  assert.equal(stats.totals.requests, 1);
  assert.equal(stats.cacheWriteStatus, "unmetered");
  assert.equal(stats.byProviderModel[0]?.cacheWriteStatus, "unmetered");
});
