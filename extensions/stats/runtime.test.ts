import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import statsExtension from "./index.ts";
import {
  loadStatsWarningConfig,
  saveStatsWarningConfig,
} from "./src/warning-config.ts";

type Handler = (event: any, context: any) => unknown;

function tempConfigPath() {
  return join(
    mkdtempSync(join(tmpdir(), "pi-stats-runtime-test-")),
    "config.private.json",
  );
}

function harness({ warningMode = "all" }: { warningMode?: string } = {}) {
  const configPath = tempConfigPath();
  process.env.PI_STATS_CONFIG_PATH = configPath;
  if (warningMode !== "all") {
    writeFileSync(configPath, `${JSON.stringify({ warningMode })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const notifications: Array<{ message: string; type: string }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerTool() {},
  };
  statsExtension(pi as any);

  const context = {
    hasUI: true,
    model: {
      provider: "synthetic",
      id: "model",
      cost: { cacheRead: 0.02 },
    },
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
  };
  const emit = async (event: string, value: any, ctx = context) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(value, ctx);
    }
  };
  return { commands, configPath, context, emit, notifications };
}

function payload({
  system = "stable system",
  tools = ["read"],
  conversation = ["first"],
  model = "model",
}: {
  system?: string;
  tools?: string[];
  conversation?: string[];
  model?: string;
} = {}) {
  return {
    model,
    messages: [
      { role: "system", content: system },
      ...conversation.map((content, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content,
      })),
    ],
    tools: tools.map((name) => ({ name })),
  };
}

function assistant({
  provider = "synthetic",
  model = "model",
  input = 10_000,
  cacheRead = 0,
}: {
  provider?: string;
  model?: string;
  input?: number;
  cacheRead?: number;
} = {}) {
  return {
    message: {
      role: "assistant",
      provider,
      model,
      content: [],
      usage: {
        input,
        output: 1,
        cacheRead,
        cacheWrite: 0,
        totalTokens: input + cacheRead + 1,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

async function request(
  runtime: ReturnType<typeof harness>,
  requestPayload: unknown,
  message = assistant(),
  context = runtime.context,
) {
  await runtime.emit(
    "before_provider_request",
    { payload: requestPayload },
    context,
  );
  await runtime.emit("message_end", message, context);
}

test("warns once for a stable warm miss, clears after recovery, and warns again", async () => {
  const runtime = harness();
  await request(runtime, payload());
  assert.equal(runtime.notifications.length, 0, "cold start is suppressed");

  await request(
    runtime,
    payload({ conversation: ["first", "answer", "second"] }),
  );
  assert.equal(runtime.notifications.length, 1);
  assert.equal(runtime.notifications[0]?.type, "warning");
  assert.match(runtime.notifications[0]?.message ?? "", /cache regression/i);

  await request(
    runtime,
    payload({ conversation: ["first", "answer", "third"] }),
  );
  assert.equal(runtime.notifications.length, 1, "same regression is deduped");

  await request(
    runtime,
    payload({ conversation: ["first", "answer", "fourth"] }),
    assistant({ input: 58, cacheRead: 11_648 }),
  );
  assert.equal(runtime.notifications.length, 1);

  await request(
    runtime,
    payload({ conversation: ["first", "answer", "fifth"] }),
  );
  assert.equal(runtime.notifications.length, 2, "recovery rearms the guard");
});

test("suppresses the first request after tools, model, or provider change", async () => {
  const runtime = harness();
  await request(runtime, payload());
  await request(runtime, payload({ tools: ["read", "web_fetch"] }));
  assert.equal(runtime.notifications.length, 0, "tool change is suppressed");
  await request(runtime, payload({ tools: ["read", "web_fetch"] }));
  assert.equal(
    runtime.notifications.length,
    1,
    "a repeated stable miss after the tool change is reported",
  );

  await request(
    runtime,
    payload({ tools: ["read", "web_fetch"], model: "other" }),
    assistant({ model: "other" }),
    {
      ...runtime.context,
      model: { provider: "synthetic", id: "other", cost: { cacheRead: 0.02 } },
    },
  );
  assert.equal(runtime.notifications.length, 1, "model change is suppressed");

  await request(
    runtime,
    payload({ tools: ["read", "web_fetch"], model: "other" }),
    assistant({ provider: "other-provider", model: "other" }),
    {
      ...runtime.context,
      model: {
        provider: "other-provider",
        id: "other",
        cost: { cacheRead: 0.02 },
      },
    },
  );
  assert.equal(runtime.notifications.length, 1, "new provider is cold");
});

test("an unmetered error does not turn the next request into a warm request", async () => {
  const runtime = harness();
  await request(runtime, payload(), assistant({ input: 0, cacheRead: 0 }));
  await request(runtime, payload());
  assert.equal(runtime.notifications.length, 0);
  await request(runtime, payload());
  assert.equal(runtime.notifications.length, 1);
});

test("session start clears warm history, pending payloads, and warning dedupe", async () => {
  const runtime = harness();
  await request(runtime, payload());
  await request(runtime, payload());
  assert.equal(runtime.notifications.length, 1);

  await runtime.emit("before_provider_request", { payload: payload() });
  await runtime.emit("session_start", {});
  await runtime.emit("message_end", assistant());
  assert.equal(
    runtime.notifications.length,
    1,
    "a pending request from the old session is discarded",
  );

  await request(runtime, payload());
  assert.equal(
    runtime.notifications.length,
    1,
    "the first request in the new session is cold",
  );
  await request(runtime, payload());
  assert.equal(
    runtime.notifications.length,
    2,
    "the new session can independently report a stable miss",
  );
});

test("does not warn without UI or priced cache support", async () => {
  const runtime = harness();
  const noCache = {
    ...runtime.context,
    model: { provider: "synthetic", id: "model", cost: { cacheRead: 0 } },
  };
  await request(runtime, payload(), assistant(), noCache);
  await request(runtime, payload(), assistant(), noCache);
  assert.equal(runtime.notifications.length, 0);

  const headless = { ...runtime.context, hasUI: false };
  await request(
    runtime,
    payload({ model: "headless" }),
    assistant({ model: "headless" }),
    headless,
  );
  await request(
    runtime,
    payload({ model: "headless" }),
    assistant({ model: "headless" }),
    headless,
  );
  assert.equal(runtime.notifications.length, 0);
});

test("compares stability with the prior request for the same provider and model", async () => {
  const runtime = harness();
  const alternate = {
    ...runtime.context,
    model: { provider: "other", id: "other", cost: { cacheRead: 0.02 } },
  };
  await request(runtime, payload());
  await request(
    runtime,
    payload({ system: "other system", model: "other" }),
    assistant({ provider: "other", model: "other" }),
    alternate,
  );
  await request(runtime, payload());
  assert.equal(
    runtime.notifications.length,
    1,
    "A → B → A still compares the second A request with the first A request",
  );
});

test("cache-affinity changes invalidate stability", async () => {
  const runtime = harness();
  await request(runtime, { ...payload(), prompt_cache_key: "first" });
  await request(runtime, { ...payload(), prompt_cache_key: "second" });
  assert.equal(runtime.notifications.length, 0);
});

test("observed telemetry enables the guard for zero-priced cache reads", async () => {
  const runtime = harness();
  const freeCache = {
    ...runtime.context,
    model: { provider: "free", id: "model", cost: { cacheRead: 0 } },
  };
  await request(
    runtime,
    payload(),
    assistant({ provider: "free", input: 2000, cacheRead: 8000 }),
    freeCache,
  );
  await request(
    runtime,
    payload(),
    assistant({ provider: "free", input: 10_000, cacheRead: 0 }),
    freeCache,
  );
  assert.equal(runtime.notifications.length, 1);
});

test("actionable mode suppresses a single-turn miss", async () => {
  const runtime = harness({ warningMode: "actionable" });
  await request(runtime, payload());
  await request(runtime, payload(), assistant({ input: 25_000 }));
  assert.equal(runtime.notifications.length, 0);
});

test("actionable mode warns on the second consecutive miss", async () => {
  const runtime = harness({ warningMode: "actionable" });
  await request(runtime, payload());
  await request(runtime, payload(), assistant({ input: 25_000 }));
  await request(runtime, payload(), assistant({ input: 25_000 }));
  assert.equal(runtime.notifications.length, 1);
  assert.equal(runtime.notifications[0]?.type, "warning");
});

test("actionable mode suppresses a small-denominator early turn", async () => {
  const runtime = harness({ warningMode: "actionable" });
  await request(runtime, payload());
  await request(runtime, payload(), assistant({ input: 10_000 }));
  assert.equal(runtime.notifications.length, 0);
});

test("all warning mode reports the first stable warm miss", async () => {
  const runtime = harness({ warningMode: "all" });
  await request(runtime, payload());
  await request(runtime, payload(), assistant({ input: 10_000 }));
  assert.equal(runtime.notifications.length, 1);
  assert.equal(runtime.notifications[0]?.type, "warning");
});

test("stats warning config round-trips and falls back for corrupt or partial config", async () => {
  const configPath = tempConfigPath();
  await saveStatsWarningConfig({ warningMode: "actionable" }, configPath);
  assert.deepEqual(loadStatsWarningConfig(configPath), {
    warningMode: "actionable",
  });

  writeFileSync(configPath, "{", "utf8");
  assert.deepEqual(loadStatsWarningConfig(configPath), { warningMode: "all" });

  writeFileSync(configPath, "{}\n", "utf8");
  assert.deepEqual(loadStatsWarningConfig(configPath), { warningMode: "all" });
});

test("stats-warnings command reports and updates the warning mode", async () => {
  const runtime = harness();
  const command = runtime.commands.get("stats-warnings");
  assert.ok(command);

  await command.handler("", runtime.context);
  assert.match(runtime.notifications.at(-1)?.message ?? "", /mode: all/);

  await command.handler("actionable", runtime.context);
  assert.deepEqual(loadStatsWarningConfig(runtime.configPath), {
    warningMode: "actionable",
  });
  assert.match(
    runtime.notifications.at(-1)?.message ?? "",
    /set to actionable/,
  );

  await command.handler("", runtime.context);
  assert.match(runtime.notifications.at(-1)?.message ?? "", /mode: actionable/);
});

test("stats prompt reports the last request and its cache outcome", async () => {
  const runtime = harness();
  const stats = runtime.commands.get("stats");
  assert.ok(stats);

  await stats.handler("prompt", runtime.context);
  assert.match(
    runtime.notifications.at(-1)?.message ?? "",
    /No provider request/,
  );

  await request(runtime, payload());
  await request(
    runtime,
    payload({ conversation: ["first", "answer", "second"] }),
    assistant({ input: 58, cacheRead: 11_648 }),
  );
  await stats.handler("prompt", runtime.context);
  const report = runtime.notifications.at(-1)?.message ?? "";
  assert.match(report, /Last provider payload/);
  assert.match(report, /Cache 99\.5%/);
  assert.match(report, /tools .* \(1\)/);
});
