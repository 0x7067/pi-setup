import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatActivityStatus,
  formatStatusLine,
  STATUS_GLYPH,
} from "./activity-status.ts";

type Theme = ExtensionContext["ui"]["theme"];

// The footer strips color before rendering a status, so these assertions read
// the plain text an owner actually sees.
const theme = {
  fg(_role: string, text: string) {
    return text;
  },
} as unknown as Theme;

test("leads with the label so compact mode can keep it", () => {
  const status = formatActivityStatus(theme, "subagents", {
    running: 1,
    done: 0,
    failed: 0,
  });
  assert.match(status, /^subagents: /);
});

test("gives each state its own glyph", () => {
  const status = formatActivityStatus(theme, "workflows", {
    running: 1,
    done: 2,
    failed: 3,
  });
  assert.equal(
    status,
    "workflows: ▶ 1 running · ✓ 2 done · ! 3 failed · /workflows to view",
  );
  assert.equal(
    new Set(Object.values(STATUS_GLYPH)).size,
    Object.values(STATUS_GLYPH).length,
  );
});

test("omits states with no work in them", () => {
  const status = formatActivityStatus(theme, "workflows", {
    running: 0,
    done: 1,
    failed: 0,
  });
  assert.equal(status, "workflows: ✓ 1 done · /workflows to view");
});

test("names a viewing command that differs from the label", () => {
  const status = formatActivityStatus(
    theme,
    "terminals",
    { running: 2, done: 0, failed: 0 },
    "/ps",
  );
  assert.equal(status, "terminals: ▶ 2 running · /ps to view");
});

test("omits the trailing hint when no command opens the detail", () => {
  const status = formatStatusLine(theme, "summaries", [
    `${STATUS_GLYPH.running} summarizing run`,
  ]);
  assert.equal(status, "summaries: ▶ summarizing run");
});
