import assert from "node:assert/strict";
import test from "node:test";
import { reduce, type ApplyContext } from "./state/state-reducer.ts";
import { previewScrollKey, type QuestionnaireState } from "./state/state.ts";
import type { QuestionData } from "./tool/types.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";
import { renderBorderedBox } from "./view/components/preview/preview-box-renderer.ts";

function previewQuestion(): QuestionData {
	return {
		question: "Pick?",
		header: "Q",
		options: [
			{ label: "alpha", description: "desc", preview: "# Alpha\n\nLong config here." },
			{ label: "bravo", description: "desc" },
		],
	};
}

function ctxFor(q: QuestionData): ApplyContext {
	const items: WrappingSelectItem[] = [
		...q.options.map((o) => ({ kind: "option" as const, label: o.label })),
		{ kind: "other" as const, label: "Type something." },
	];
	return { questions: [q], itemsByTab: [items] };
}

function stateFor(overrides?: Partial<QuestionnaireState>): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		previewScrollByKey: new Map(),
		previewExpandedKeys: new Set(),
		...overrides,
	};
}

test("preview_scroll down/up accumulates per-option offsets, clamped at zero", () => {
	const q = previewQuestion();
	const ctx = ctxFor(q);
	let s = stateFor().previewScrollByKey;
	let r = reduce(stateFor(), { kind: "preview_scroll", direction: "down" }, ctx);
	assert.equal(r.state.previewScrollByKey.get(previewScrollKey(0, 0)), 8);
	r = reduce(r.state, { kind: "preview_scroll", direction: "down" }, ctx);
	assert.equal(r.state.previewScrollByKey.get(previewScrollKey(0, 0)), 16);
	r = reduce(r.state, { kind: "preview_scroll", direction: "up" }, ctx);
	assert.equal(r.state.previewScrollByKey.get(previewScrollKey(0, 0)), 8);
	r = reduce(r.state, { kind: "preview_scroll", direction: "top" }, ctx);
	assert.equal(r.state.previewScrollByKey.get(previewScrollKey(0, 0)), 0);
	// up at zero is a no-op (offset stays an explicit 0 from the earlier top)
	r = reduce(r.state, { kind: "preview_scroll", direction: "up" }, ctx);
	assert.equal(r.state.previewScrollByKey.get(previewScrollKey(0, 0)), 0);
	assert.equal(s.size, 0);
});

test("preview_scroll bottom stores an unbounded offset the view clamps", () => {
	const q = previewQuestion();
	const r = reduce(stateFor(), { kind: "preview_scroll", direction: "bottom" }, ctxFor(q));
	assert.equal(r.state.previewScrollByKey.get(previewScrollKey(0, 0)), Number.MAX_SAFE_INTEGER);
});

test("preview scroll/expand no-op without a focused preview", () => {
	const q = previewQuestion();
	const ctx = ctxFor(q);
	// bravo (index 1) carries no preview
	const noPreview = stateFor({ optionIndex: 1 });
	assert.equal(reduce(noPreview, { kind: "preview_scroll", direction: "down" }, ctx).state, noPreview);
	assert.equal(reduce(noPreview, { kind: "preview_toggle_expand" }, ctx).state, noPreview);
	// multi-select questions render no preview pane
	const multi: QuestionData = { ...q, multiSelect: true };
	const multiCtx: ApplyContext = { questions: [multi], itemsByTab: ctx.itemsByTab };
	const multiState = stateFor();
	assert.equal(reduce(multiState, { kind: "preview_scroll", direction: "down" }, multiCtx).state, multiState);
});

test("preview_toggle_expand flips a remembered per-option flag, preserving scroll", () => {
	const q = previewQuestion();
	const ctx = ctxFor(q);
	const scrolled = reduce(stateFor(), { kind: "preview_scroll", direction: "down" }, ctx).state;
	const expanded = reduce(scrolled, { kind: "preview_toggle_expand" }, ctx).state;
	assert.ok(expanded.previewExpandedKeys.has(previewScrollKey(0, 0)));
	assert.equal(expanded.previewScrollByKey.get(previewScrollKey(0, 0)), 8);
	const collapsed = reduce(expanded, { kind: "preview_toggle_expand" }, ctx).state;
	assert.ok(!collapsed.previewExpandedKeys.has(previewScrollKey(0, 0)));
	assert.equal(collapsed.previewScrollByKey.get(previewScrollKey(0, 0)), 8);
});

test("renderBorderedBox shows directional scroll indicators", () => {
	const identity = (s: string) => s;
	const plain = renderBorderedBox(["a"], 20, identity);
	assert.ok(plain[plain.length - 1]?.startsWith("└─"));
	const below = renderBorderedBox(["a"], 30, identity, 21, 0);
	assert.match(below[below.length - 1] ?? "", /↓ 21 below/);
	const both = renderBorderedBox(["a"], 40, identity, 12, 5);
	assert.match(both[both.length - 1] ?? "", /↑ 5 above · ↓ 12 below/);
	const aboveOnly = renderBorderedBox(["a"], 40, identity, 0, 3);
	assert.match(aboveOnly[aboveOnly.length - 1] ?? "", /↑ 3 above/);
	assert.doesNotMatch(aboveOnly[aboveOnly.length - 1] ?? "", /↓/);
});
