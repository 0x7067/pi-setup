/**
 * Layer composition and the async entry-point boundary.
 *
 * Everything inside the extension is Effect generators; this module is where
 * tool handlers (plain async functions) run those effects against one shared
 * ManagedRuntime.
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import {
  BackendRegistry,
  type BackendCapabilities,
  type SubagentBackend,
} from "./backend.ts";
import { SpawnError, type BackendName } from "./domain.ts";

export function lazyBackend(
  name: BackendName,
  capabilities: BackendCapabilities,
  load: () => Promise<SubagentBackend>,
): SubagentBackend {
  let loaded: Promise<SubagentBackend> | undefined;
  const get = () => (loaded ??= load());

  return {
    name,
    capabilities,
    available: Effect.tryPromise({
      try: get,
      catch: (error) =>
        new SpawnError({
          message: `Failed to load ${name} backend: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }).pipe(
      Effect.flatMap((backend) => backend.available),
      // `available` is intentionally infallible at the backend boundary. Keep
      // lazy import failures observable as defects instead of misreporting a
      // broken module as a normal unavailable installation.
      Effect.orDie,
    ),
    spawn: (task) =>
      Effect.tryPromise({
        try: get,
        catch: (error) =>
          new SpawnError({
            message: `Failed to load ${name} backend: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }).pipe(Effect.flatMap((backend) => backend.spawn(task))),
  };
}

const piBackend = lazyBackend(
  "pi",
  { steering: true, modelSelection: true, reasoningEffort: true },
  () => import("./backends/pi.ts").then((module) => module.piBackend),
);
const claudeBackend = lazyBackend(
  "claude",
  { steering: true, modelSelection: true, reasoningEffort: true },
  () => import("./backends/claude.ts").then((module) => module.claudeBackend),
);
const codexBackend = lazyBackend(
  "codex",
  { steering: false, modelSelection: true, reasoningEffort: true },
  () => import("./backends/codex.ts").then((module) => module.codexBackend),
);

const BackendRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [piBackend, claudeBackend, codexBackend];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

import { SubagentManagerLive } from "./manager.ts";

const AppLayer = SubagentManagerLive.pipe(Layer.provide(BackendRegistryLive));

export function createSubagentRuntime() {
  return ManagedRuntime.make(AppLayer);
}

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;

/**
 * Run an effect from an async tool handler. Typed failures and defects are
 * converted to thrown Errors (what pi's tool contract expects); interruption
 * (tool AbortSignal) throws `interruptMessage`.
 */
export async function runTool<A, E>(
  runtime: SubagentRuntime,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; interruptMessage?: string } = {},
) {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(options.interruptMessage ?? "Operation was aborted.");
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
