import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  acquireTuiSession,
  installConsoleGuard,
  isConsoleGuardPatched,
  logDiagnostic,
  releaseTuiSession,
  restoreConsole,
} from "./console-guard.ts";

test("console guard installs, redirects writes off the terminal, and restores", () => {
  const originalError = console.error;
  const seen: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    seen.push(args);
  };
  try {
    acquireTuiSession();
    assert.equal(isConsoleGuardPatched(), true);
    // Redirected: the terminal-bound stub must not observe the call.
    console.error("Warning: TT: undefined function: 32");
    assert.equal(seen.length, 0);

    // Nested sessions share one installation.
    acquireTuiSession();
    releaseTuiSession();
    assert.equal(isConsoleGuardPatched(), true);
    releaseTuiSession();
    assert.equal(isConsoleGuardPatched(), false);

    // Restored: calls flow to the terminal-bound stub again.
    console.error("back on screen");
    assert.equal(seen.length, 1);
  } finally {
    restoreConsole();
    console.error = originalError;
  }
});

test("manual install/restore is idempotent", () => {
  installConsoleGuard();
  installConsoleGuard();
  assert.equal(isConsoleGuardPatched(), true);
  restoreConsole();
  restoreConsole();
  assert.equal(isConsoleGuardPatched(), false);
});

test("logDiagnostic never throws", () => {
  logDiagnostic("tui-guard self-test");
});
