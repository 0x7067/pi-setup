import { Cause, Exit, ManagedRuntime, type Effect } from "effect";
import { CommandRunner, CommandRunnerLive } from "./process.ts";

export function createRuntime() {
  return ManagedRuntime.make(CommandRunnerLive);
}

export type GitInfoRuntime = ReturnType<typeof createRuntime>;

export async function runEffect<A, E>(
  runtime: GitInfoRuntime,
  effect: Effect.Effect<A, E, CommandRunner>,
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
