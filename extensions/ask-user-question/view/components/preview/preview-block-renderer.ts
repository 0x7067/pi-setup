import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { t } from "../../../state/i18n-bridge.ts";
import type { QuestionData } from "../../../tool/types.ts";
import {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	MarkdownContentCache,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.ts";
import {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	computeBoxDimensions,
	renderBorderedBox,
} from "./preview-box-renderer.ts";
import type { PreviewLayoutMode } from "./preview-layout-decider.ts";

/**
 * Affordance text shown below the bordered preview when focused on a preview-bearing option.
 * Re-exported by `preview-pane.ts` for the existing test surface.
 */
export const NOTES_AFFORDANCE_TEXT = "Notes: press n to add notes";

/** Content row budget for a layout mode: preview cap minus border + affordance overhead. */
function contentBudgetFor(mode: PreviewLayoutMode): number {
	const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
	return Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
}

/**
 * Chrome rows reserved around the preview block when expanded (heading, borders,
 * footer, minimal options column). Expanded fills the terminal beyond this;
 * anything still overflowing stays reachable via the in-place scroll window.
 */
const EXPANDED_CHROME_RESERVE = 12;

/** Expanded content budget: fill the terminal when the preview fits, else the fixed cap or larger. */
function expandedContentBudgetFor(mode: PreviewLayoutMode, terminalRows: number | undefined): number {
	const normalCap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
	const cap = Math.max(normalCap, (terminalRows ?? 0) - EXPANDED_CHROME_RESERVE);
	return Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
}

function budgetFor(mode: PreviewLayoutMode, opts?: PreviewBlockOptions): number {
	if (opts?.expanded) return expandedContentBudgetFor(mode, opts.terminalRows);
	return contentBudgetFor(mode);
}

/**
 * Clamp a scroll offset into the window over `rawLength` rows and derive the
 * above/below hidden counts plus the visible row count. `blockHeight` and
 * `renderBlock` share this so `render().length` always equals the measured
 * height — the `DialogView` residual math depends on that parity.
 */
function resolveWindow(
	rawLength: number,
	budget: number,
	scrollOffset: number,
): { offset: number; above: number; below: number; count: number } {
	const maxOffset = Math.max(0, rawLength - budget);
	const offset = Math.max(0, Math.min(Math.floor(scrollOffset), maxOffset));
	const count = Math.min(budget, Math.max(0, rawLength - offset));
	return { offset, above: offset, below: rawLength - (offset + count), count };
}

/** Inner (padding-aware) content width for a total block width. */
function innerWidthFor(width: number): number {
	return Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);
}

export interface PreviewBlockRendererConfig {
	question: QuestionData;
	theme: Theme;
	markdownTheme: MarkdownTheme;
}

/** Per-render preview viewport. All fields optional so existing call sites keep compiling. */
export interface PreviewBlockOptions {
	/** Lines scrolled from the top; upper-clamped by the view against the wrapped row count. */
	scrollOffset?: number;
	/** Fill the terminal instead of the fixed cap (full render when the content fits). */
	expanded?: boolean;
	/** Terminal height for the expanded budget. Absent behaves like the fixed cap. */
	terminalRows?: number;
}

/**
 * Renders the bordered markdown preview block for a single question (one block per render call,
 * for the option at `optionIndex`). Owns a per-question `MarkdownContentCache`.
 *
 * NOT a `Component` — pure render-and-measure helper consumed by `PreviewPane`. The layout mode
 * is threaded as an explicit param (never re-derived from column width post-split).
 *
 * The affordance row is always emitted (visually empty when gated) so the preview block's row
 * count is height-stable across affordance-state transitions.
 */
export class PreviewBlockRenderer {
	private readonly theme: Theme;
	private readonly cache: MarkdownContentCache;

	constructor(config: PreviewBlockRendererConfig) {
		this.theme = config.theme;
		this.cache = new MarkdownContentCache(config.question, config.theme, config.markdownTheme);
	}

	hasAnyPreview(): boolean {
		return this.cache.hasAnyPreview();
	}

	has(optionIndex: number): boolean {
		return this.cache.has(optionIndex);
	}

	invalidate(): void {
		this.cache.invalidate();
	}

	/**
	 * Height contribution of the preview block: `BORDER_VERTICAL_OVERHEAD + contentRows +
	 * NOTES_AFFORDANCE_OVERHEAD`. Always returns the same value as `renderBlock(...).length`
	 * for the same options — the affordance overhead is constant, not gated by
	 * `focused`/`notesVisible`, and scroll offset only moves the window.
	 */
	blockHeight(width: number, optionIndex: number, mode: PreviewLayoutMode, opts?: PreviewBlockOptions): number {
		const budget = budgetFor(mode, opts);
		const innerWidth = innerWidthFor(width);
		const rawRows = this.cache.bodyFor(optionIndex, innerWidth).length;
		const win = resolveWindow(rawRows, budget, opts?.scrollOffset ?? 0);
		return BORDER_VERTICAL_OVERHEAD + win.count + NOTES_AFFORDANCE_OVERHEAD;
	}

	/**
	 * Render the full preview block at `width`: bordered box + blank separator + affordance row.
	 * `focused` and `notesVisible` together gate the affordance text (visible only when the
	 * focused option carries a preview AND notes mode is inactive). The affordance row is ALWAYS
	 * emitted (as an empty string when gated) so the row count is invariant.
	 */
	renderBlock(
		width: number,
		optionIndex: number,
		mode: PreviewLayoutMode,
		focused: boolean,
		notesVisible: boolean,
		opts?: PreviewBlockOptions,
	): string[] {
		const budget = budgetFor(mode, opts);
		const maxInnerWidth = innerWidthFor(width);

		const raw = this.cache.bodyFor(optionIndex, maxInnerWidth);
		const win = resolveWindow(raw.length, budget, opts?.scrollOffset ?? 0);
		const contentLines = raw.slice(win.offset, win.offset + budget);

		const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
		const colorFn = (s: string) => this.theme.fg("accent", s);
		const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, win.below, win.above);

		const showAffordance = focused && !notesVisible && this.cache.has(optionIndex);
		const affordance = showAffordance
			? this.theme.fg("muted", t("preview.notes_affordance", NOTES_AFFORDANCE_TEXT))
			: "";
		return [...boxedLines, "", affordance];
	}
}
