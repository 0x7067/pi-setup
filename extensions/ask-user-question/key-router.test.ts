import assert from "node:assert/strict";
import test from "node:test";
import { Key, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { routeKey, type QuestionnaireAction, type QuestionnaireKeybindings } from "./state/key-router.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state/state.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";
import type { QuestionData } from "./tool/types.ts";

const DIGIT_1 = "1";
const DIGIT_2 = "2";
const DIGIT_3 = "3";
const DIGIT_4 = "4";
const DIGIT_5 = "5";
/** Kitty CSI-u sequence for the "1" key (codepoint 49, no modifiers). */
const KITTY_1 = "\u001b[49u";
/** Kitty CSI-u sequence for shift+"1" (codepoint 49, modifier 2). */
const KITTY_SHIFT_1 = "\u001b[49;2u";

function makeKb(overrides?: { confirmKeys?: KeyId[] }): QuestionnaireKeybindings {
	const confirmKeys = overrides?.confirmKeys ?? ["enter"];
	return {
		matches: (data, name) => {
			if (name === "tui.select.confirm" || name === "tui.input.submit") {
				return confirmKeys.some((k) => matchesKey(data, k));
			}
			if (name === "tui.select.cancel") return matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
			if (name === "tui.select.up") return matchesKey(data, "up");
			if (name === "tui.select.down") return matchesKey(data, "down");
			if (name === "tui.input.newLine") return matchesKey(data, "shift+enter") || matchesKey(data, "ctrl+j");
			if (name === "tui.editor.deleteToLineStart") return matchesKey(data, "ctrl+u");
			return false;
		},
	};
}

function baseState(overrides?: Partial<QuestionnaireState>): QuestionnaireState {
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

function questionData(
	options: { label: string; description?: string }[],
	multiSelect = false,
): QuestionData {
	return {
		question: "Pick?",
		header: "Q",
		multiSelect,
		options: options.map((o) => ({ label: o.label, description: o.description ?? "desc" })),
	};
}

function makeRuntime(
	question: QuestionData,
	overrides?: Partial<QuestionnaireRuntime>,
): QuestionnaireRuntime {
	const optionItems: WrappingSelectItem[] = question.options.map((o) => ({ kind: "option", label: o.label }));
	const items: WrappingSelectItem[] = [...optionItems];
	if (!question.multiSelect) {
		items.push({ kind: "other", label: "Type something." });
	} else {
		items.push({ kind: "other", label: "Type something." });
		items.push({ kind: "next", label: "Next" });
	}
	return {
		keybindings: makeKb(),
		inputBuffer: "",
		canMoveInputUp: false,
		canMoveInputDown: false,
		questions: [question],
		isMulti: false,
		currentItem: items[0],
		items,
		collapseKey: "off",
		...overrides,
	};
}

function singleSelectAction(data: string, optionIndex = 0, overrides?: Partial<QuestionnaireState>): QuestionnaireAction {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }, { label: "charlie" }, { label: "delta" }]);
	const state = baseState({ optionIndex, ...overrides });
	const runtime = makeRuntime(q, { currentItem: q.options[optionIndex] ? { kind: "option", label: q.options[optionIndex].label } : undefined });
	return routeKey(data, state, runtime);
}

function multiSelectAction(data: string, optionIndex = 0, overrides?: Partial<QuestionnaireState>): QuestionnaireAction {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }, { label: "charlie" }], true);
	const state = baseState({ optionIndex, ...overrides });
	const runtime = makeRuntime(q, { currentItem: q.options[optionIndex] ? { kind: "option", label: q.options[optionIndex].label } : undefined });
	return routeKey(data, state, runtime);
}

test("single-select: bare digit 1..N selects and confirms that option", () => {
	assert.deepEqual(singleSelectAction(DIGIT_2), {
		kind: "confirm",
		answer: {
			questionIndex: 0,
			question: "Pick?",
			kind: "option",
			answer: "bravo",
		},
		autoAdvanceTab: undefined,
	});
});

test("single-select: works from any focused index", () => {
	assert.deepEqual(singleSelectAction(DIGIT_3, 0), {
		kind: "confirm",
		answer: {
			questionIndex: 0,
			question: "Pick?",
			kind: "option",
			answer: "charlie",
		},
		autoAdvanceTab: undefined,
	});
});

test("single-select: digit > option count is ignored", () => {
	assert.equal(singleSelectAction(DIGIT_5).kind, "ignore");
});

test("single-select: digit for the Type-something row is ignored", () => {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }]);
	const state = baseState({ optionIndex: 0 });
	const runtime = makeRuntime(q, { currentItem: { kind: "option", label: "alpha" } });
	assert.equal(routeKey("3", state, runtime).kind, "ignore");
});

test("single-select: shift+digit does not quick-select", () => {
	assert.equal(singleSelectAction(DIGIT_2).kind, "confirm");
	// Legacy "!" (shift+1)
	assert.equal(singleSelectAction("!").kind, "ignore");
	// Kitty shift+1
	assert.equal(singleSelectAction(KITTY_SHIFT_1).kind, "ignore");
});

test("single-select: a digit bound to confirm still behaves as confirm", () => {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }, { label: "charlie" }]);
	const state = baseState({ optionIndex: 1 }); // focused on bravo
	const runtime = makeRuntime(q, {
		currentItem: { kind: "option", label: "bravo" },
		keybindings: makeKb({ confirmKeys: ["2"] }),
	});
	const action = routeKey("2", state, runtime);
	assert.equal(action.kind, "confirm");
	assert.equal(action.kind === "confirm" && action.answer.kind === "option" ? action.answer.answer : null, "bravo");
});

test("multi-select: bare digit 1..N toggles that option's checkbox", () => {
	assert.deepEqual(multiSelectAction(DIGIT_2, 0), { kind: "toggle", index: 1 });
});

test("multi-select: digit toggle does not submit", () => {
	const action = multiSelectAction(DIGIT_2, 2);
	assert.equal(action.kind, "toggle");
	assert.equal((action as Extract<QuestionnaireAction, { kind: "toggle" }>).index, 1);
});

test("multi-select: digit out of range or on sentinel rows is ignored", () => {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }, { label: "charlie" }], true);
	// option count is 3; digit 4 is the Type-something row, 5 is Next.
	assert.equal(multiSelectAction("4", 0).kind, "ignore");
	assert.equal(multiSelectAction("5", 0).kind, "ignore");
});

test("multi-select: digit with shift is ignored", () => {
	assert.equal(multiSelectAction(KITTY_SHIFT_1, 0).kind, "ignore");
});

test("input mode: digits go to the text buffer, never select", () => {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }]);
	const state = baseState({ optionIndex: 2, inputMode: true });
	const runtime = makeRuntime(q, { currentItem: { kind: "other", label: "Type something." }, inputBuffer: "" });
	const action = routeKey(DIGIT_2, state, runtime);
	assert.equal(action.kind, "ignore");
});

test("notes mode: digits are forwarded to the notes editor", () => {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }]);
	const state = baseState({ optionIndex: 0, notesVisible: true });
	const runtime = makeRuntime(q, { currentItem: { kind: "option", label: "alpha" } });
	const action = routeKey(DIGIT_2, state, runtime);
	assert.deepEqual(action, { kind: "notes_forward", data: DIGIT_2 });
});

test("collapsed mode: digit is swallowed", () => {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }]);
	const state = baseState({ optionIndex: 0, collapsed: true });
	const runtime = makeRuntime(q, { currentItem: { kind: "option", label: "alpha" } });
	const action = routeKey(DIGIT_2, state, runtime);
	assert.equal(action.kind, "ignore");
});

test("Kitty CSI-u digit quick-selects the option", () => {
	assert.deepEqual(singleSelectAction(KITTY_1, 0), {
		kind: "confirm",
		answer: {
			questionIndex: 0,
			question: "Pick?",
			kind: "option",
			answer: "alpha",
		},
		autoAdvanceTab: undefined,
	});
});

const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";
const HOME = "\u001b[H";
const END = "\u001b[F";

test("single-select: PgUp/PgDn/Home/End route to preview_scroll", () => {
	assert.deepEqual(singleSelectAction(PAGE_UP), { kind: "preview_scroll", direction: "up" });
	assert.deepEqual(singleSelectAction(PAGE_DOWN), { kind: "preview_scroll", direction: "down" });
	assert.deepEqual(singleSelectAction(HOME), { kind: "preview_scroll", direction: "top" });
	assert.deepEqual(singleSelectAction(END), { kind: "preview_scroll", direction: "bottom" });
});

test("single-select: e routes to preview_toggle_expand", () => {
	assert.deepEqual(singleSelectAction("e"), { kind: "preview_toggle_expand" });
});

test("preview keys are dead while typing, noting, collapsed, or multi-select", () => {
	const q = questionData([{ label: "alpha" }, { label: "bravo" }]);
	const otherItem = { kind: "other", label: "Type something." } as const;
	// inputMode: keystroke belongs to the inline editor
	const inputRuntime = makeRuntime(q, { currentItem: otherItem, inputBuffer: "" });
	assert.equal(routeKey("e", baseState({ optionIndex: 2, inputMode: true }), inputRuntime).kind, "ignore");
	assert.equal(routeKey(PAGE_DOWN, baseState({ optionIndex: 2, inputMode: true }), inputRuntime).kind, "ignore");
	// notesVisible: forwarded to the notes editor
	const notesRuntime = makeRuntime(q, { currentItem: { kind: "option", label: "alpha" } });
	assert.deepEqual(routeKey("e", baseState({ notesVisible: true }), notesRuntime), {
		kind: "notes_forward",
		data: "e",
	});
	// collapsed: swallowed
	assert.equal(routeKey("e", baseState({ collapsed: true }), notesRuntime).kind, "ignore");
	// multi-select renders no preview pane
	assert.equal(multiSelectAction("e", 0).kind, "ignore");
	assert.equal(multiSelectAction(PAGE_DOWN, 0).kind, "ignore");
});
