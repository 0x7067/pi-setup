import { NodeServices } from "@effect/platform-node";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Data, Effect, Exit } from "effect";
import {
  currentTarget,
  liveBinaryEnv,
  repositoryBinDir,
  resolveBinary,
  TOOL_SPECS,
  type BinaryEnv,
  type BinarySource,
  type PlatformTarget,
  type ResolvedBinary,
} from "./binaries.ts";
import { formatCapturedOutput, type CapturedOutput } from "./output.ts";
import { discardCapturedOutput, executeSearchProcess } from "./process.ts";

export function makeBinaryInitializers(
  binDir: string,
  target: PlatformTarget,
  env: BinaryEnv,
) {
  return {
    fd: Effect.runSync(
      Effect.cached(resolveBinary(TOOL_SPECS.fd, binDir, target, env)),
    ),
    rg: Effect.runSync(
      Effect.cached(resolveBinary(TOOL_SPECS.rg, binDir, target, env)),
    ),
  };
}

/** Human-readable install notice, shown only for fresh downloads. */
export function installNotifications(binaries: readonly ResolvedBinary[]) {
  return binaries
    .filter((binary) => binary.source === "installed")
    .map(
      (binary) =>
        `file-search: no system ${binary.tool} found — downloaded ${binary.tool} ${binary.version ?? ""}`.trimEnd() +
        ` to ${repositoryBinDir()}`,
    );
}

class SearchError extends Data.TaggedError("SearchError")<{
  readonly message: string;
}> {}

interface SearchOutcome {
  readonly output: CapturedOutput;
  readonly noMatches: boolean;
  readonly binarySource: BinarySource;
}

export interface FdToolDetails {
  readonly binarySource: BinarySource;
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface RgToolDetails {
  readonly binarySource: BinarySource;
  readonly outputLines: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

const EXEC_TIMEOUT_MS = 60_000;

function causeMessage<E>(cause: Cause.Cause<E>) {
  const [first] = Cause.prettyErrors(cause);
  return first?.message ?? Cause.pretty(cause);
}

function unwrapToolExit<A, E>(exit: Exit.Exit<A, E>, tool: "fd" | "rg") {
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(`${tool} search was cancelled.`);
  }
  throw new Error(causeMessage(exit.cause));
}

let initializers: ReturnType<typeof makeBinaryInitializers> | undefined;
let notified = false;

function getInitializers() {
  return (initializers ??= makeBinaryInitializers(
    repositoryBinDir(),
    currentTarget(),
    liveBinaryEnv,
  ));
}

export async function notifySetup(ctx: ExtensionContext) {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const init = getInitializers();
      const initialized = yield* Effect.all(
        {
          fd: Effect.exit(init.fd),
          rg: Effect.exit(init.rg),
        },
        { concurrency: "unbounded" },
      );
      if (!ctx.hasUI || notified) return;

      notified = true;
      for (const tool of ["fd", "rg"] as const) {
        const toolExit = initialized[tool];
        if (Exit.isSuccess(toolExit)) {
          for (const message of installNotifications([toolExit.value])) {
            ctx.ui.notify(message, "info");
          }
        } else {
          ctx.ui.notify(
            `file-search ${tool} setup failed: ${causeMessage(toolExit.cause)}`,
            "error",
          );
        }
      }
    }),
  );

  if (Exit.isFailure(exit) && ctx.hasUI && !notified) {
    notified = true;
    ctx.ui.notify(
      `file-search setup failed: ${causeMessage(exit.cause)}`,
      "error",
    );
  }
}

/** Await init, stream the binary output to disk, and classify its exit. */
function runSearch(tool: "fd" | "rg", args: string[], ctx: ExtensionContext) {
  return Effect.gen(function* () {
    const binary = yield* getInitializers()[tool];
    const result = yield* executeSearchProcess({
      command: binary.command,
      args,
      cwd: ctx.cwd,
      tempPrefix: `pi-${tool}-`,
    });

    // ripgrep exits 1 for "no matches"; fd exits 0 even with no results.
    if (tool === "rg" && result.code === 1 && result.output.lineCount === 0) {
      return {
        output: result.output,
        noMatches: true,
        binarySource: binary.source,
      } satisfies SearchOutcome;
    }
    if (result.code !== 0) {
      yield* discardCapturedOutput(result.output);
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      return yield* new SearchError({ message: `${tool} failed: ${detail}` });
    }
    return {
      output: result.output,
      noMatches: result.output.lineCount === 0,
      binarySource: binary.source,
    } satisfies SearchOutcome;
  }).pipe(
    Effect.timeout(EXEC_TIMEOUT_MS),
    Effect.mapError((error) => {
      if (error instanceof SearchError) return error;
      return new SearchError({
        message:
          error._tag === "TimeoutError"
            ? `${tool} timed out.`
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }),
    Effect.provide(NodeServices.layer),
  );
}

export async function runFd(
  args: string[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const outcome = yield* runSearch("fd", args, ctx);
      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: {
            binarySource: outcome.binarySource,
            matchCount: 0,
            truncated: false,
          },
        } satisfies AgentToolResult<FdToolDetails>;
      }

      const formatted = formatCapturedOutput(outcome.output);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binarySource,
          matchCount: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      } satisfies AgentToolResult<FdToolDetails>;
    }),
    signal ? { signal } : undefined,
  );
  return unwrapToolExit(exit, "fd");
}

export async function runRg(
  args: string[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const outcome = yield* runSearch("rg", args, ctx);
      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: {
            binarySource: outcome.binarySource,
            outputLines: 0,
            truncated: false,
          },
        } satisfies AgentToolResult<RgToolDetails>;
      }

      const formatted = formatCapturedOutput(outcome.output);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binarySource,
          outputLines: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      } satisfies AgentToolResult<RgToolDetails>;
    }),
    signal ? { signal } : undefined,
  );
  return unwrapToolExit(exit, "rg");
}
