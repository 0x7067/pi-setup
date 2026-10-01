import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  BTW_TITLE_MAX_LENGTH,
  buildBtwContextPreamble,
  deriveBtwTitle,
  isModelVisible,
} from "./src/by-the-way.ts";

test("deriveBtwTitle uses the first non-empty line and bounds the title", () => {
  assert.equal(
    deriveBtwTitle("\n   Why   does this work?   \nignore me"),
    "Why does this work?",
  );
  assert.equal(deriveBtwTitle(" \n\t"), "by the way");

  const title = deriveBtwTitle("x".repeat(BTW_TITLE_MAX_LENGTH + 10));
  assert.equal(title.length, BTW_TITLE_MAX_LENGTH);
  assert.equal(title, `${"x".repeat(BTW_TITLE_MAX_LENGTH - 1)}…`);

  const emojiTitle = deriveBtwTitle(
    `${"x".repeat(BTW_TITLE_MAX_LENGTH - 2)}😀 more`,
  );
  assert.equal(emojiTitle, `${"x".repeat(BTW_TITLE_MAX_LENGTH - 2)}😀…`);
});

test("only model-origin snapshots are visible to model-facing tools", () => {
  assert.equal(isModelVisible({ origin: "model" }), true);
  assert.equal(isModelVisible({ origin: "btw" }), false);
});

type BtwSessionManager = Parameters<typeof buildBtwContextPreamble>[0];

/** Minimal fake session manager that yields the given messages as entries. */
function fakeSessionManager(messages: Message[]): BtwSessionManager {
  return {
    buildContextEntries: () =>
      messages.map((message, i) => ({
        type: "message",
        id: `e${i}`,
        parentId: null,
        timestamp: "",
        message,
      })),
  } as unknown as BtwSessionManager;
}

const user = (content: string): Message =>
  ({ role: "user", content, timestamp: 0 }) as unknown as Message;

const assistant = (
  text: string,
  tools: { name: string; arguments?: Record<string, unknown> }[] = [],
): Message =>
  ({
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...tools.map((t) => ({
        type: "toolCall",
        id: "c",
        name: t.name,
        arguments: t.arguments ?? {},
      })),
    ],
    timestamp: 0,
  }) as unknown as Message;

const toolResult = (toolName: string, text: string, isError = false): Message =>
  ({
    role: "toolResult",
    toolCallId: "c",
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  }) as unknown as Message;

test("buildBtwContextPreamble returns '' for an empty session", () => {
  assert.equal(buildBtwContextPreamble(fakeSessionManager([])), "");
});

test("buildBtwContextPreamble summarizes recent user/assistant/tool activity", () => {
  const preamble = buildBtwContextPreamble(
    fakeSessionManager([
      user("is ampart stuck"),
      assistant("let me check", [{ name: "bg_list" }]),
      toolResult("bg_list", "No background terminals."),
      assistant("No, nothing is stuck."),
    ]),
  );
  assert.ok(preamble.startsWith("Current session context"));
  assert.match(preamble, /user: is ampart stuck/);
  assert.match(preamble, /assistant: let me check/);
  assert.match(preamble, /→ bg_list\b/);
  assert.match(preamble, /result\(bg_list\): No background terminals\./);
  assert.match(preamble, /assistant: No, nothing is stuck\./);
});

test("buildBtwContextPreamble tags errored tool results", () => {
  const preamble = buildBtwContextPreamble(
    fakeSessionManager([user("run build"), toolResult("bash", "exit 1", true)]),
  );
  assert.match(preamble, /error\(bash\): exit 1/);
});

test("buildBtwContextPreamble keeps only the most recent entries", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 20; i++) messages.push(user(`msg ${i}`));
  const preamble = buildBtwContextPreamble(fakeSessionManager(messages));
  assert.doesNotMatch(preamble, /msg 0\b/);
  assert.match(preamble, /msg 19/);
});
