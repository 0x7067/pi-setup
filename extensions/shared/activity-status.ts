import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

interface ActivityCounts {
  running: number;
  done: number;
  failed: number;
  /** Jobs explicitly cancelled by the user or model. */
  cancelled?: number;
}

// The footer strips control sequences — and therefore color — from extension
// statuses before it renders them, so the glyph and the word are all that
// distinguish one state from another there.
export const STATUS_GLYPH = {
  running: "▶",
  done: "✓",
  failed: "!",
  cancelled: "⊘",
} as const;

/**
 * `label: part · part · /command to view`. Every status the footer aggregates
 * uses this shape, so compact mode can keep the label and drop the rest.
 */
export function formatStatusLine(
  theme: Theme,
  label: string,
  parts: readonly string[],
  command?: string,
) {
  const trailing = command
    ? [theme.fg("accent", command) + theme.fg("dim", " to view")]
    : [];
  const body = [...parts, ...trailing].join(theme.fg("dim", " · "));
  return `${theme.fg("muted", `${label}:`)} ${body}`;
}

export function formatActivityStatus(
  theme: Theme,
  label: string,
  counts: ActivityCounts,
  command = `/${label}`,
) {
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(
      theme.fg("warning", `${STATUS_GLYPH.running} ${counts.running} running`),
    );
  }
  if (counts.done > 0) {
    parts.push(theme.fg("success", `${STATUS_GLYPH.done} ${counts.done} done`));
  }
  if (counts.cancelled && counts.cancelled > 0) {
    parts.push(theme.fg("muted", `${STATUS_GLYPH.cancelled} ${counts.cancelled} cancelled`));
  }
  if (counts.failed > 0) {
    parts.push(
      theme.fg("error", `${STATUS_GLYPH.failed} ${counts.failed} failed`),
    );
  }

  return formatStatusLine(theme, label, parts, command);
}
