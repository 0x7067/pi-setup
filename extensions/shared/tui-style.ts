import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ActionHint {
  key: string;
  label: string;
}

export function renderActionHints(
  theme: Theme,
  actions: readonly ActionHint[],
  prefix = "  ",
) {
  return (
    prefix +
    actions
      .map(
        ({ key, label }) =>
          theme.fg("accent", key) + theme.fg("dim", ` ${label}`),
      )
      .join(theme.fg("dim", " · "))
  );
}

export function highlightRow(
  theme: Theme,
  text: string,
  width: number,
  active: boolean,
) {
  const truncated = truncateToWidth(text, width);
  const row = `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
  return active ? theme.bg("selectedBg", row) : truncated;
}

/** Pads or truncates one row to an exact cell width. */
export function padRow(text: string, width: number) {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/**
 * Top edge of a rounded overlay panel, with the title set into the rule.
 * `innerWidth` excludes the two corner cells.
 */
export function panelTop(theme: Theme, innerWidth: number, title: string) {
  const label = title
    ? ` ${truncateToWidth(title, Math.max(0, innerWidth - 3))} `
    : "";
  const rule = "─".repeat(Math.max(0, innerWidth - 1 - visibleWidth(label)));
  return (
    theme.fg("border", "╭─") +
    (label ? theme.fg("text", label) : "") +
    theme.fg("border", `${rule}╮`)
  );
}

/** Bottom edge of a rounded overlay panel. `innerWidth` excludes the corners. */
export function panelBottom(theme: Theme, innerWidth: number) {
  return theme.fg("border", `╰${"─".repeat(Math.max(0, innerWidth))}╯`);
}
