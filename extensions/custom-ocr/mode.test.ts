import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  MODE_ENTRY_TYPE,
  parsePrivateImageArgs,
  persistDefaultMode,
  preferencePath,
  readDefaultMode,
  readModeFromBranch,
} from "./src/mode.ts";

const modeEntry = (mode: string) => ({
  type: "custom",
  customType: MODE_ENTRY_TYPE,
  data: { mode },
});

test("readModeFromBranch defaults to luna", () => {
  assert.equal(readModeFromBranch([]), "luna");
  assert.equal(
    readModeFromBranch([
      { type: "message" },
      { type: "custom", customType: "other" },
    ]),
    "luna",
  );
});

test("readModeFromBranch returns the most recent mode entry", () => {
  assert.equal(readModeFromBranch([modeEntry("private")]), "private");
  assert.equal(
    readModeFromBranch([modeEntry("private"), modeEntry("luna")]),
    "luna",
  );
  assert.equal(
    readModeFromBranch([modeEntry("luna"), modeEntry("private")]),
    "private",
  );
});

test("readModeFromBranch ignores malformed entries", () => {
  assert.equal(
    readModeFromBranch([
      modeEntry("private"),
      { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "bogus" } },
      { type: "custom", customType: MODE_ENTRY_TYPE, data: undefined },
    ]),
    "private",
  );
});

test("parsePrivateImageArgs toggles with no argument", () => {
  assert.deepEqual(parsePrivateImageArgs("", "luna"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs(undefined, "private"), {
    action: "set",
    mode: "luna",
  });
});

test("parsePrivateImageArgs handles on/off/status", () => {
  assert.deepEqual(parsePrivateImageArgs("on", "luna"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs(" ON ", "private"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs("off", "private"), {
    action: "set",
    mode: "luna",
  });
  assert.deepEqual(parsePrivateImageArgs("status", "luna"), {
    action: "status",
  });
});

test("parsePrivateImageArgs rejects unknown arguments", () => {
  const result = parsePrivateImageArgs("maybe", "luna");
  assert.equal(result.action, "error");
});

test("readModeFromBranch falls back to the given default", () => {
  assert.equal(readModeFromBranch([], "private"), "private");
  assert.equal(readModeFromBranch([{ type: "message" }], "private"), "private");
  // A branch entry still wins over the default.
  assert.equal(readModeFromBranch([modeEntry("luna")], "private"), "luna");
});

test("preferencePath sits under the agent config directory", () => {
  assert.equal(
    preferencePath("/agent"),
    resolve("/agent", "config", "custom-ocr"),
  );
});

test("readDefaultMode round-trips what persistDefaultMode writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "custom-ocr-mode-"));
  try {
    const path = join(dir, "config", "custom-ocr");
    // Missing file means Luna, so a fresh install is unchanged.
    assert.equal(readDefaultMode(path), "luna");

    persistDefaultMode(path, "private");
    assert.equal(readDefaultMode(path), "private");

    persistDefaultMode(path, "luna");
    assert.equal(readDefaultMode(path), "luna");

    // Anything unrecognized fails safe to the hosted backend.
    writeFileSync(path, "wat\n");
    assert.equal(readDefaultMode(path), "luna");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistDefaultMode leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "custom-ocr-mode-"));
  try {
    const path = join(dir, "custom-ocr");
    persistDefaultMode(path, "private");
    assert.deepEqual(readdirSync(dir), ["custom-ocr"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
