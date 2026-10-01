/**
 * Branch-local mode bookkeeping for custom-ocr.
 *
 * The current mode ("luna" for the hosted default, "private" for the
 * fail-closed local pipeline) is persisted as a custom session entry so it
 * survives reload/resume and follows the branch when forked.
 *
 * Which mode a genuinely new session starts in comes from
 * `<agent>/config/custom-ocr`, written whenever the mode changes, so leaving
 * private mode on is a one-time `/private-image on`. Same file convention as
 * the calm extension's preference.
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export type OcrMode = "luna" | "private";

export const MODE_ENTRY_TYPE = "custom-ocr-mode";

export interface ModeEntryData {
  readonly mode: OcrMode;
}

interface BranchEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export function isOcrMode(value: unknown): value is OcrMode {
  return value === "luna" || value === "private";
}

/** Path of the file holding the mode new sessions start in. */
export function preferencePath(root: string) {
  const configDirectory =
    process.env.CUSTOM_OCR_CONFIG_OVERRIDE || resolve(root, "config");
  return resolve(configDirectory, "custom-ocr");
}

/** The mode a session starts in. Unreadable or unrecognized content means Luna. */
export function readDefaultMode(path: string): OcrMode {
  try {
    const value = readFileSync(path, "utf8").trim();
    return isOcrMode(value) ? value : "luna";
  } catch {
    return "luna";
  }
}

/**
 * Record the mode new sessions start in. Written through a temp file so a
 * crash mid-write cannot leave a truncated preference behind. Failure is
 * silent on purpose: losing the preference must never break a parse.
 */
export function persistDefaultMode(path: string, mode: OcrMode): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporaryPath, `${mode}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Nothing to clean up.
    }
  }
}

/**
 * Walk the current branch and return the most recent persisted mode, falling
 * back to the mode new sessions start in when the branch has none.
 */
export function readModeFromBranch(
  entries: readonly BranchEntryLike[],
  fallback: OcrMode = "luna",
) {
  let mode: OcrMode = fallback;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) {
      continue;
    }
    const data = entry.data as Partial<ModeEntryData> | undefined;
    if (data && isOcrMode(data.mode)) mode = data.mode;
  }
  return mode;
}

export type PrivateImageAction =
  | { readonly action: "set"; readonly mode: OcrMode }
  | { readonly action: "status" }
  | { readonly action: "error"; readonly message: string };

/**
 * Parse `/private-image` arguments. No argument toggles, `on`/`off` set the
 * mode explicitly, and `status` reports the current state.
 */
export function parsePrivateImageArgs(
  args: string | undefined,
  current: OcrMode,
): PrivateImageAction {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed === "") {
    return { action: "set", mode: current === "private" ? "luna" : "private" };
  }
  if (trimmed === "on") return { action: "set", mode: "private" };
  if (trimmed === "off") return { action: "set", mode: "luna" };
  if (trimmed === "status") return { action: "status" };
  return {
    action: "error",
    message: `Unknown argument "${trimmed}". Use /private-image [on|off|status].`,
  };
}
