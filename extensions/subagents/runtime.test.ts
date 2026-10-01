import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeStubBackend } from "./src/backends/stub.ts";
import { SpawnError } from "./src/domain.ts";
import { lazyBackend } from "./src/runtime.ts";

const capabilities = {
  steering: true,
  modelSelection: true,
  reasoningEffort: true,
} as const;

test("lazy backend preserves a diagnostic import failure", async () => {
  const backend = lazyBackend("claude", capabilities, async () => {
    throw new Error("missing SDK dependency");
  });

  await assert.rejects(
    Effect.runPromise(backend.available),
    (error: unknown) =>
      error instanceof SpawnError &&
      error.message === "Failed to load claude backend: missing SDK dependency",
  );
});

test("lazy backend reports genuine unavailability as false", async () => {
  const loadedBackend = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "test",
    contextWindow: 1_000,
    toolName: "test",
    cadenceMs: 0,
  });
  const backend = lazyBackend("claude", capabilities, async () => ({
    ...loadedBackend,
    available: Effect.succeed(false),
  }));

  assert.equal(await Effect.runPromise(backend.available), false);
});
