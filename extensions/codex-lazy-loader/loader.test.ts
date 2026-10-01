import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelSelectEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createConditionalCodexExtension,
  isCodexLikeModel,
} from "../010-lazy-codex-conversion.ts";

type Event = SessionStartEvent | ModelSelectEvent;
type Handler = (event: Event, ctx: ExtensionContext) => Promise<unknown> | unknown;

const model = (provider: string, id: string) =>
  ({ provider, id }) as Model<any>;

function createHarness(
  importFactory: Parameters<typeof createConditionalCodexExtension>[0],
) {
  const handlers = new Map<string, Handler[]>();
  let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const pi = {
    on(event: string, handler: Handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
      return () => undefined;
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;
  createConditionalCodexExtension(importFactory)(pi);

  return {
    async dispatch(
      event: Event,
      model = event.type === "model_select" ? event.model : undefined,
      context: Partial<ExtensionContext> = {},
    ) {
      const ctx = {
        model,
        ...context,
        ui: context.ui ?? {
          onTerminalInput(handler: typeof terminalInput) {
            terminalInput = handler;
            return () => {
              terminalInput = undefined;
            };
          },
          notify() {},
        },
      } as ExtensionContext;
      for (const handler of [...(handlers.get(event.type) ?? [])]) {
        await handler(event, ctx);
      }
    },
    input(data: string) {
      return terminalInput?.(data);
    },
  };
}

test("matches the Codex package's conservative model detection", () => {
  assert.equal(isCodexLikeModel({ provider: "devin", id: "swe-2" }), false);
  assert.equal(isCodexLikeModel({ provider: "openai-codex", id: "gpt-5.5" }), true);
  assert.equal(isCodexLikeModel({ provider: "openai", id: "gpt-5" }), true);
  assert.equal(isCodexLikeModel({ provider: "openrouter", id: "openai/gpt-5" }), false);
  assert.equal(isCodexLikeModel({ provider: "devin", id: "gpt-5.3-codex" }), true);
  assert.equal(isCodexLikeModel({ provider: "github-copilot", id: "gpt-5" }), true);
});

test("does not import Codex conversion for an unrelated startup model", async () => {
  let imports = 0;
  const harness = createHarness(async () => {
    imports++;
    return () => undefined;
  });

  await harness.dispatch(
    { type: "session_start", reason: "startup" },
    model("devin", "swe-2"),
  );

  assert.equal(imports, 0);
});

test("loads on a Codex startup model and replays session_start", async () => {
  const calls: string[] = [];
  const harness = createHarness(async () => (pi) => {
    pi.on("session_start", (event) => {
      calls.push(`start:${event.reason}`);
    });
    pi.on("model_select", (event) => {
      calls.push(`model:${event.model.id}`);
    });
  });

  await harness.dispatch(
    { type: "session_start", reason: "startup" },
    model("openai-codex", "gpt-5.5"),
  );

  assert.deepEqual(calls, ["start:startup"]);
});

test("loads on the first Codex switch and replays both lifecycle events", async () => {
  let imports = 0;
  const calls: string[] = [];
  const harness = createHarness(async () => {
    imports++;
    return (pi) => {
      pi.on("session_start", (event) => {
        calls.push(`start:${event.reason}`);
      });
      pi.on("model_select", (event) => {
        calls.push(`model:${event.model.id}`);
      });
    };
  });

  await harness.dispatch(
    { type: "session_start", reason: "startup" },
    model("devin", "swe-2"),
  );
  await harness.dispatch({
    type: "model_select",
    model: model("openai-codex", "gpt-5.5"),
    previousModel: model("devin", "swe-2"),
    source: "set",
  });
  await harness.dispatch({
    type: "model_select",
    model: model("openai-codex", "gpt-5.6-luna"),
    previousModel: model("openai-codex", "gpt-5.5"),
    source: "cycle",
  });

  assert.equal(imports, 1);
  assert.deepEqual(calls, [
    "start:startup",
    "model:gpt-5.5",
    "model:gpt-5.6-luna",
  ]);
});

test("retries a failed lazy import on the next relevant model event", async () => {
  let imports = 0;
  const harness = createHarness(async () => {
    imports++;
    if (imports === 1) throw new Error("temporary import failure");
    return () => undefined;
  });
  const event: ModelSelectEvent = {
    type: "model_select",
    model: model("openai-codex", "gpt-5.5"),
    previousModel: model("devin", "swe-2"),
    source: "set",
  };

  await assert.rejects(harness.dispatch(event), /temporary import failure/);
  await harness.dispatch(event);

  assert.equal(imports, 2);
});

test("bridges shortcuts when Codex loads after TUI initialization", async () => {
  let shortcutCalls = 0;
  const harness = createHarness(async () => (pi) => {
    pi.registerShortcut("alt+w", {
      handler: () => {
        shortcutCalls++;
      },
    });
  });

  await harness.dispatch(
    { type: "session_start", reason: "startup" },
    model("devin", "swe-2"),
    { mode: "tui" },
  );
  await harness.dispatch(
    {
      type: "model_select",
      model: model("openai-codex", "gpt-5.5"),
      previousModel: model("devin", "swe-2"),
      source: "set",
    },
    undefined,
    { mode: "tui" },
  );

  assert.deepEqual(harness.input("\u001bw"), { consume: true });
  await Promise.resolve();
  assert.equal(shortcutCalls, 1);
});
