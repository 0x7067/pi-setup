import assert from "node:assert/strict";
import test from "node:test";
import { runRpcQuestionnaire, type DialogUI } from "./rpc-fallback.ts";
import type { QuestionData, QuestionParams } from "./tool/types.ts";

const opt = (label: string, description = "desc for " + label): QuestionData["options"][number] => ({
	label,
	description,
});

const singleParams = (options: QuestionData["options"], multiSelect = false): QuestionParams => ({
	questions: [{ question: "Pick one?", header: "Q", multiSelect, options }],
});

/** Recording DialogUI stub — queues select/input answers in order. */
function stub(replies: { select?: (string | undefined)[]; input?: (string | undefined)[] }) {
	const calls: { kind: string; title: string; options?: string[] }[] = [];
	const ui: DialogUI = {
		select: async (title, options) => {
			calls.push({ kind: "select", title, options });
			return replies.select?.shift();
		},
		input: async (title, placeholder) => {
			calls.push({ kind: "input", title, options: placeholder === undefined ? undefined : [placeholder] });
			return replies.input?.shift();
		},
	};
	return { ui, calls };
}

test("single-select resolves the chosen option by exact line, not by leading number", async () => {
	// A label that itself begins with a digit must not shadow the row number.
	const { ui } = stub({ select: ["2. 3rd option — desc for 3rd option"] });
	const params = singleParams([opt("1st option"), opt("3rd option")]);
	const result = await runRpcQuestionnaire(ui, params);
	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Pick one?",
		kind: "option",
		answer: "3rd option",
		preview: undefined,
	});
});

test("single-select: a host reply outside the offered list is a dismissal", async () => {
	const { ui } = stub({ select: ["bogus line not offered"] });
	const result = await runRpcQuestionnaire(ui, singleParams([opt("a"), opt("b")]));
	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, []);
});

test("single-select: the Type-something row opens a free-text input", async () => {
	const { ui, calls } = stub({ select: ["3. Type something."], input: ["my own words"] });
	const result = await runRpcQuestionnaire(ui, singleParams([opt("a"), opt("b")]));
	assert.equal(calls[1]?.kind, "input");
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Pick one?",
		kind: "custom",
		answer: "my own words",
	});
});

test("multi-select: a valid index list commits the checked options", async () => {
	const { ui } = stub({ input: ["1,3"] });
	const params = singleParams([opt("a"), opt("b"), opt("c")], true);
	const result = await runRpcQuestionnaire(ui, params);
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Pick one?",
		kind: "multi",
		answer: null,
		selected: ["a", "c"],
	});
});

test("multi-select: an empty entry is a deliberate empty commit", async () => {
	const { ui } = stub({ input: ["   "] });
	const result = await runRpcQuestionnaire(ui, singleParams([opt("a"), opt("b")], true));
	assert.deepEqual(result.answers[0]?.selected, []);
});

test("multi-select: an out-of-range number re-prompts then accepts a correction", async () => {
	const { ui, calls } = stub({ input: ["13", "2"] });
	const params = singleParams([opt("a"), opt("b"), opt("c")], true);
	const result = await runRpcQuestionnaire(ui, params);
	assert.equal(calls.filter((c) => c.kind === "input").length, 2);
	assert.match(calls[1]?.title ?? "", /not option numbers/);
	assert.deepEqual(result.answers[0]?.selected, ["b"]);
});

test("multi-select: a mixed numeric+word entry re-prompts as a malformed selection", async () => {
	const { ui, calls } = stub({ input: ["1, banana", "1,2"] });
	const result = await runRpcQuestionnaire(ui, singleParams([opt("a"), opt("b")], true));
	assert.equal(calls.filter((c) => c.kind === "input").length, 2);
	assert.deepEqual(result.answers[0]?.selected, ["a", "b"]);
});

test("multi-select: a purely non-numeric entry stays a custom answer", async () => {
	const { ui, calls } = stub({ input: ["none of these"] });
	const result = await runRpcQuestionnaire(ui, singleParams([opt("a"), opt("b")], true));
	assert.equal(calls.filter((c) => c.kind === "input").length, 1);
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Pick one?",
		kind: "custom",
		answer: "none of these",
	});
});

test("multi-select: exhausted retries on invalid input cancel the question", async () => {
	const { ui, calls } = stub({ input: ["9", "9", "9"] });
	const result = await runRpcQuestionnaire(ui, singleParams([opt("a"), opt("b")], true));
	assert.equal(calls.filter((c) => c.kind === "input").length, 3);
	assert.equal(result.cancelled, true);
});
