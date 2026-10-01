import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function agentDir(): string {
  try {
    return getAgentDir();
  } catch {
    return process.cwd();
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Append a diagnostic line without touching the terminal. */
export function logDiagnostic(message: string): void {
  try {
    const dir = join(agentDir(), ".runtime");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "tui-console-guard.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Logging must never throw into tool execution.
  }
}

type ConsoleMethod = "debug" | "error" | "info" | "log" | "warn";
const PATCHED_METHODS: readonly ConsoleMethod[] = ["debug", "error", "info", "log", "warn"];

type GuardState = {
  patched: boolean;
  tuiSessions: number;
  originals: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>>;
};

const GUARD_KEY = Symbol.for("my-pi-setup:console-guard");

function guardState(): GuardState {
  const registry = globalThis as typeof globalThis & {
    [GUARD_KEY]?: GuardState;
  };
  registry[GUARD_KEY] ??= { patched: false, tuiSessions: 0, originals: {} };
  return registry[GUARD_KEY];
}

function redirectToFile(...args: unknown[]): void {
  logDiagnostic(args.map(safeStringify).join(" "));
}

export function installConsoleGuard(): void {
  const state = guardState();
  if (state.patched) return;
  for (const method of PATCHED_METHODS) {
    const original = console[method] as (...args: unknown[]) => void;
    state.originals[method] = original.bind(console);
    console[method] = redirectToFile;
  }
  state.patched = true;
}

export function restoreConsole(): void {
  const state = guardState();
  if (!state.patched) return;
  for (const method of PATCHED_METHODS) {
    const original = state.originals[method];
    if (original) console[method] = original as never;
    delete state.originals[method];
  }
  state.patched = false;
}

/** Track one fullscreen TUI session; the guard stays installed until the last one leaves. */
export function acquireTuiSession(): void {
  const state = guardState();
  state.tuiSessions += 1;
  if (state.tuiSessions === 1) installConsoleGuard();
}

/** Release one fullscreen TUI session; restores the console when none remain. */
export function releaseTuiSession(): void {
  const state = guardState();
  if (state.tuiSessions <= 0) return;
  state.tuiSessions -= 1;
  if (state.tuiSessions === 0) restoreConsole();
}

export function isConsoleGuardPatched(): boolean {
  return guardState().patched;
}
