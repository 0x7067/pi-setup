import { execFile } from "node:child_process";
import { Context, Effect, Layer } from "effect";

// Local Effect is 4.0.0-beta.102, which no longer ships
// `effect/unstable/process`. This keeps upstream's CommandRunner interface
// while spawning through node:child_process instead.
const MAX_STREAM_CHARS = 10 * 1_024 * 1_024;
const TRUNCATED_MARKER = "\n[command output truncated]\n";

function appendBounded(current: string, chunk: string) {
  if (current.endsWith(TRUNCATED_MARKER)) return current;
  if (current.length + chunk.length <= MAX_STREAM_CHARS) return current + chunk;
  const remaining = Math.max(0, MAX_STREAM_CHARS - current.length);
  return `${current}${chunk.slice(0, remaining)}${TRUNCATED_MARKER}`;
}

export interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface CommandRunnerShape {
  run(
    command: string,
    args: string[],
    cwd: string,
    timeout: number,
  ): Effect.Effect<CommandResult>;
}

export class CommandRunner extends Context.Service<
  CommandRunner,
  CommandRunnerShape
>()("git-info/CommandRunner") {}

function appendCommandFailure(stderr: string, command: string, error: Error) {
  const failure = `Failed to run ${command}: ${error.message}`;
  return stderr ? `${stderr.trimEnd()}\n${failure}` : failure;
}

interface ExecFileError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function spawnOnce(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      execFile(
        command,
        args,
        { cwd, timeout, maxBuffer: MAX_STREAM_CHARS, windowsHide: true },
        (error, stdout, stderr) => {
          const failure = error as ExecFileError | null;
          if (!failure) {
            done({
              code: 0,
              stderr: appendBounded("", stderr),
              stdout: appendBounded("", stdout),
            });
            return;
          }
          if (failure.killed) {
            done({
              code: -1,
              stderr: appendBounded("", stderr),
              stdout: appendBounded("", stdout),
            });
            return;
          }
          if (
            failure.code === "ENOENT" ||
            /not found|ENOENT/i.test(failure.message)
          ) {
            done({
              code: 1,
              stderr: appendBounded(
                "",
                appendCommandFailure(stderr, command, failure),
              ),
              stdout: appendBounded("", stdout),
            });
            return;
          }
          done({
            code:
              typeof failure.code === "number" &&
              Number.isInteger(failure.code)
                ? failure.code
                : 1,
            stderr: appendBounded("", stderr),
            stdout: appendBounded("", stdout),
          });
        },
      );
    } catch (error) {
      done({
        code: 1,
        stderr:
          error instanceof Error
            ? appendCommandFailure("", command, error)
            : String(error),
        stdout: "",
      });
    }
  });
}

function runOnce(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
): Effect.Effect<CommandResult, never, never> {
  return Effect.promise(() => spawnOnce(command, args, cwd, timeout)).pipe(
    Effect.catch((failure: unknown) =>
      Effect.succeed({
        code: 1,
        stderr:
          failure instanceof Error
            ? appendCommandFailure("", command, failure)
            : String(failure),
        stdout: "",
      }),
    ),
  );
}

export const CommandRunnerLive = Layer.succeed(CommandRunner, {
  run: (command, args, cwd, timeout) => runOnce(command, args, cwd, timeout),
});

export const runCommand = (
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
) =>
  Effect.gen(function* () {
    const commands = yield* CommandRunner;
    return yield* commands.run(command, args, cwd, timeout);
  });
