import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { TuiMainScreen, visibleWidth, CombinedAutocompleteProvider, CURSOR_MARKER, getCapabilities, setCapabilities, type Terminal } from "@earendil-works/pi-tui";
import { ComposerEditor } from "./editor.ts";
import { Attachments, readPreview } from "./attachments.ts";
import { referenceCompletion, expandSkillReferences, type Reference } from "./references.ts";
import composer from "./index.ts";

const plain = (s: string) => s;
const theme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
function fixture(rows = 36) {
  const terminal: Terminal = {
    rows, columns: 90, kittyProtocolActive: false, start() {}, stop() {}, write() {}, moveBy() {},
    hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    async drainInput() {},
  };
  const tui = new TuiMainScreen(terminal);
  const sent: string[] = [];
  const inspected: string[] = [];
  const editor = new ComposerEditor(tui, theme, new KeybindingsManager(), {
    isWorking: () => false, inspect: (a) => { inspected.push(a.path); },
  });
  editor.onSubmit = (s) => { sent.push(s); };
  editor.focused = true;
  return { editor, sent, inspected, tui };
}
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("stash is a single immediate slot preserving text, cursor, undo and paste content", () => {
  const { editor, sent } = fixture();
  editor.insertTextAtCursor("review $how\n");
  const large = "line of source\n".repeat(20);
  editor.handleInput(paste(large));
  editor.handleInput("\x1b[D");
  const cursor = editor.getCursor();
  const original = editor.getExpandedText();
  editor.swapStash();
  assert.equal(editor.getText(), "");
  assert.equal(editor.hasStash(), true);
  editor.insertTextAtCursor("quick question");
  editor.handleInput("\r");
  assert.deepEqual(sent, ["quick question"]);
  editor.swapStash();
  assert.equal(editor.hasStash(), false);
  assert.equal(editor.getExpandedText(), original);
  assert.deepEqual(editor.getCursor(), cursor);
  editor.handleInput("\x1f");
  assert.equal(editor.getExpandedText(), "review $how\n");
});

test("occupied drafts swap without overwrite; empty stash is a no-op; new editor has no stash", () => {
  const { editor } = fixture();
  editor.swapStash();
  assert.equal(editor.hasStash(), false);
  editor.setText("first"); editor.swapStash(); editor.setText("second"); editor.swapStash();
  assert.equal(editor.getText(), "first");
  editor.swapStash(); assert.equal(editor.getText(), "second");
  assert.equal(fixture().editor.hasStash(), false);
});

test("CSI-u Shift+Enter and Ctrl+J insert newlines; Enter sends; app shortcuts survive", () => {
  const { editor, sent } = fixture();
  let model = 0;
  editor.onAction("app.model.select", () => { model++; });
  editor.handleInput("a"); editor.handleInput("\x1b[13;2u"); editor.handleInput("b"); editor.handleInput("\n"); editor.handleInput("c");
  assert.equal(editor.getText(), "a\nb\nc");
  assert.deepEqual(sent, []);
  editor.handleInput("\x0c"); assert.equal(model, 1);
  editor.handleInput("\r"); assert.deepEqual(sent, ["a\nb\nc"]);
});

test("image draft survives stash and native queue serialization, deletion is undoable", () => {
  const { editor, sent, inspected } = fixture();
  const path = join(tmpdir(), "image-test.png");
  editor.insertTextAtCursor("compare [image #1] "); editor.insertTextAtCursor(path);
  assert.equal(editor.currentAttachments().length, 1);
  const queued = editor.getExpandedText();
  assert.equal(queued, `compare [image #1] ${path}`);
  editor.swapStash(); editor.swapStash();
  assert.equal(editor.getExpandedText(), queued);
  editor.setText(""); editor.setText(`${path}.backup.png`);
  assert.equal(editor.currentAttachments().length, 0);
  assert.equal(editor.getExpandedText(), `${path}.backup.png`);
  editor.setText(queued);
  assert.equal(editor.currentAttachments().length, 1);
  editor.focusAttachments(); editor.handleInput("\r");
  assert.deepEqual(inspected, [path]); assert.deepEqual(sent, []);
  editor.handleInput("\x7f");
  assert.equal(editor.getExpandedText(), "compare [image #1] ");
  editor.handleInput("\x1f");
  assert.equal(editor.getExpandedText(), queued);
  editor.handleInput("\r"); assert.deepEqual(sent, [queued]);
});

test("backspace at the start of the text removes the newest image", () => {
  const { editor } = fixture();
  editor.insertTextAtCursor(join(tmpdir(), "first.png")); editor.insertTextAtCursor(join(tmpdir(), "second.png"));
  editor.insertTextAtCursor("ab");
  assert.equal(editor.currentAttachments().length, 2);
  editor.handleInput("\x7f");
  assert.deepEqual(editor.getLines(), ["a"]);
  assert.equal(editor.currentAttachments().length, 2);
  editor.handleInput("\x7f");
  editor.handleInput("\x7f");
  assert.deepEqual(editor.currentAttachments().map((image) => image.name), ["first.png"]);
  editor.handleInput("\x7f");
  assert.equal(editor.currentAttachments().length, 0);
  assert.equal(editor.getExpandedText(), "");
  editor.handleInput("\x1f");
  assert.deepEqual(editor.currentAttachments().map((image) => image.name), ["first.png"]);
});

test("single dropped path with spaces is quoted for submission; split large paste stays intact", () => {
  const { editor, sent } = fixture();
  editor.handleInput(paste('"/tmp/my screenshot.png"'));
  assert.equal(editor.currentAttachments().length, 1);
  editor.handleInput("\r"); assert.deepEqual(sent, ['"/tmp/my screenshot.png"']);
  editor.handleInput("\x1b[200~first\n"); editor.handleInput("next\x1b[201~");
  assert.equal(editor.getExpandedText(), "first\nnext");
});

test("image paste preserves path boundaries and accepts multiple image references", () => {
  const { editor } = fixture();
  editor.insertTextAtCursor("describe");
  editor.handleInput(paste("/tmp/separated.png"));
  assert.equal(editor.getExpandedText(), "describe /tmp/separated.png");
  editor.setText("");
  const pair = '"/tmp/a.png" "/tmp/b.png"';
  editor.handleInput(paste(pair));
  assert.deepEqual(editor.currentAttachments().map((image) => image.path), ["/tmp/a.png", "/tmp/b.png"]);
  assert.equal(editor.getExpandedText(), "/tmp/a.png /tmp/b.png");
  assert.deepEqual(editor.getLines(), [""]);
  editor.setText("");
  editor.handleInput(paste('describe "/tmp/a.png" and more'));
  assert.deepEqual(editor.getLines(), ['describe "/tmp/a.png" and more']);
  assert.equal(editor.currentAttachments().length, 0);
  editor.setText("");
  editor.handleInput('\x1b[200~"/tmp/a.png" ');
  editor.handleInput('"/tmp/b.png"\x1b[201~');
  assert.deepEqual(editor.currentAttachments().map((image) => image.path), ["/tmp/a.png", "/tmp/b.png"]);
  assert.deepEqual(editor.getLines(), [""]);
});

test("attachment removal leaves native collapsed paste expandable", () => {
  const { editor } = fixture();
  const large = "line of source\n".repeat(20);
  const path = join(tmpdir(), "pi-clipboard-after-paste.png");
  editor.handleInput(paste(large));
  editor.insertTextAtCursor(" "); editor.insertTextAtCursor(path);
  assert.equal(editor.getExpandedText(), `${large} ${path}`);
  assert.match(editor.getText(), /\[paste #1 \+21 lines\] /);
  editor.focusAttachments(); editor.handleInput("\x7f");
  assert.equal(editor.currentAttachments().length, 0);
  assert.ok(editor.render(90).join("\n").includes("[paste #1 +21 lines]"));
  assert.equal(editor.getExpandedText(), `${large} `);
  editor.expandPastes();
  assert.ok(!editor.render(90).join("\n").includes("[paste #1"));
  assert.equal(editor.getExpandedText(), `${large} `);
});

test("queue restoration keeps collapsed paste registry through submit and undo", () => {
  const { editor } = fixture();
  const first = "first paste line\n".repeat(20);
  editor.handleInput(paste(first));
  const visible = editor.getText();
  editor.setText(`queued\n\n${visible}`);
  assert.match(editor.getText(), /^queued\n\n\[paste #1 \+21 lines\]$/);
  assert.equal(editor.getExpandedText(), `queued\n\n${first}`);
  const second = "second paste line\n".repeat(20);
  editor.handleInput(paste(second));
  assert.match(editor.getText(), /\[paste #1 \+21 lines\]\[paste #2 \+21 lines\]$/);
  assert.equal(editor.getExpandedText(), `queued\n\n${first}${second}`);
  editor.handleInput("\x1f");
  assert.equal(editor.getExpandedText(), `queued\n\n${first}`);
});

test("large pasted text containing image paths stays in native paste storage", () => {
  const { editor } = fixture();
  const path = join(tmpdir(), "pi-clipboard-existing.png");
  editor.insertTextAtCursor(path);
  editor.setText("");
  const large = `${Array.from({ length: 20 }, (_, i) => `line ${i} ${path}`).join("\n")}\n`;
  editor.handleInput(paste(large));
  assert.equal(editor.currentAttachments().length, 0);
  assert.match(editor.getText(), /^\[paste #1 \+21 lines\]$/);
  assert.equal(editor.getExpandedText(), large);
});

test("images contain no editable path or token and place the cursor immediately below the preview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composer-layout-"));
  const { editor } = fixture();
  const caps = getCapabilities();
  setCapabilities({ ...caps, images: "kitty" });
  try {
    const path = join(dir, "private-filename.png");
    await writeFile(path, png);
    editor.insertTextAtCursor(path);
    editor.render(90); await tick();
    const lines = editor.render(90);
    const imageRow = lines.findIndex((line) => line.includes("\x1b_G"));
    const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    assert.ok(imageRow >= 0);
    const imageHeight = Number(lines[imageRow].match(/\x1b_G[^;]*,r=(\d+)/)?.[1]);
    assert.ok(imageHeight > 0);
    assert.equal(cursorRow, imageRow + imageHeight);
    assert.ok(!lines.join("\n").includes("private-filename"));
    assert.ok(!lines.join("\n").includes("[image #"));
    assert.deepEqual(editor.getLines(), [""]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    editor.handleInput("describe");
    assert.deepEqual(editor.getLines(), ["describe"]);
    editor.handleInput("\x1b[D");
    assert.equal(editor.getCursor().col, 7);
    assert.equal(editor.getExpandedText(), `describe ${path}`);
  } finally { setCapabilities(caps); await rm(dir, { recursive: true, force: true }); }
});

test("multiple images form a gallery above the cursor, with independent selection and removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composer-gallery-"));
  const { editor, inspected } = fixture();
  const caps = getCapabilities();
  setCapabilities({ ...caps, images: "kitty" });
  try {
    const paths = ["first.png", "second screenshot.png", "third.png"].map((name) => join(dir, name));
    await Promise.all(paths.map((path) => writeFile(path, png)));
    editor.handleInput(paste(paths.map((path) => JSON.stringify(path)).join("\n")));
    editor.render(90); await tick();
    const lines = editor.render(90);
    const imageRows = lines.flatMap((line, index) => line.includes("\x1b_G") ? [index] : []);
    assert.equal(imageRows.length, 3);
    assert.ok(lines.findIndex((line) => line.includes(CURSOR_MARKER)) > imageRows.at(-1)!);
    for (const path of paths) assert.ok(!lines.join("\n").includes(path));
    editor.focusAttachments(); editor.handleInput("\x1b[D"); editor.handleInput("\r");
    assert.deepEqual(inspected, [paths[1]]);
    editor.handleInput("\x7f");
    assert.deepEqual(editor.currentAttachments().map((image) => image.path), [paths[0], paths[2]]);
    editor.handleInput("\x1b"); editor.handleInput("\x1f");
    assert.deepEqual(editor.currentAttachments().map((image) => image.path), paths);
    assert.deepEqual(editor.getLines(), [""]);
  } finally { setCapabilities(caps); await rm(dir, { recursive: true, force: true }); }
});

test("clicking a gallery row selects the image and a second click inspects it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composer-click-"));
  const { editor, inspected } = fixture();
  const caps = getCapabilities();
  setCapabilities({ ...caps, images: "kitty" });
  try {
    const paths = ["a.png", "b.png"].map((name) => join(dir, name));
    await Promise.all(paths.map((path) => writeFile(path, png)));
    editor.handleInput(paste(paths.join(" ")));
    editor.render(90); await tick();
    const lines = editor.render(90);
    const secondRow = lines.flatMap((line, index) => line.includes("\x1b_G") ? [index] : [])[1];
    const click = (y: number) => editor.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 90, height: lines.length, shift: false, alt: false, ctrl: false, meta: false } as never);
    assert.deepEqual(click(secondRow), { handled: true, focus: true });
    assert.ok(editor.render(90).join("\n").includes("Image 2/2"));
    click(secondRow);
    assert.deepEqual(inspected, [paths[1]]);
  } finally { setCapabilities(caps); await rm(dir, { recursive: true, force: true }); }
});

test("alt+s keypress stashes without pi shortcut forwarding and fires once with it", () => {
  const { editor } = fixture();
  assert.equal(editor.onExtensionShortcut, undefined);
  editor.insertTextAtCursor("hello draft");
  editor.handleInput("\x1bs");
  assert.equal(editor.hasStash(), true);
  assert.equal(editor.getText(), "");
  // Alt+I with no images and Alt+P with no pastes stay inert without inserting text.
  editor.handleInput("\x1bi");
  editor.handleInput("\x1bp");
  assert.equal(editor.getText(), "");
  editor.handleInput("x");
  editor.handleInput("\x1bs");
  assert.equal(editor.getText(), "hello draft");

  let piCalls = 0;
  editor.onExtensionShortcut = (data) => {
    if (data === "\x1bs") { piCalls++; editor.swapStash(); return true; }
    return false;
  };
  editor.insertTextAtCursor(" second");
  editor.handleInput("\x1bs");
  assert.equal(piCalls, 1);
  assert.equal(editor.hasStash(), true);
});

test("footer hints follow the composer state", () => {
  const { editor } = fixture();
  const footer = () => editor.render(90).join("\n");
  assert.ok(footer().includes("Type a message"));
  editor.handleInput("hello");
  assert.ok(footer().includes("Send") && footer().includes("Alt+S Stash"));
  editor.swapStash();
  assert.ok(footer().includes("Alt+S Restore draft"));
  editor.handleInput("x");
  assert.ok(footer().includes("Alt+S Swap") && footer().includes("Draft stashed"));
});

test("image-only drafts preserve stash, undo, queue restore, and submission without ghost attachments", () => {
  const { editor, sent } = fixture();
  const paths = ["/tmp/a.png", "/tmp/b.png"];
  editor.handleInput(paste(paths.join(" ")));
  editor.swapStash(); assert.equal(editor.hasStash(), true); assert.equal(editor.getText(), "");
  editor.swapStash(); assert.equal(editor.hasStash(), false);
  const queued = editor.getText();
  assert.equal(queued, paths.join(" "));
  editor.handleInput("\r"); assert.deepEqual(sent, [queued]);
  assert.equal(editor.currentAttachments().length, 0);
  editor.setText(queued);
  assert.deepEqual(editor.getLines(), [""]);
  assert.equal(editor.getText(), queued);
  editor.handleInput("\x1f");
  assert.equal(editor.currentAttachments().length, 0);
  editor.handleInput(paste(paths.join(" ")));
  let exits = 0; editor.onCtrlD = () => { exits++; };
  editor.handleInput("\x04"); assert.equal(exits, 0);
});

test("async clipboard paste stays with initiating draft", async () => {
  const { editor } = fixture();
  const path = join(tmpdir(), "pi-clipboard-async.png");
  editor.onPasteImage = () => { queueMicrotask(() => editor.insertTextAtCursor(path)); };
  editor.setText("original ");
  editor.handleInput("\x16");
  editor.swapStash();
  editor.setText("quick question ");
  await tick();
  assert.equal(editor.getExpandedText(), "quick question ");
  editor.swapStash();
  assert.equal(editor.getExpandedText(), `original ${path}`);
});

test("history navigation retains the unsent draft, including attachment references", () => {
  const { editor } = fixture();
  editor.addToHistory("older");
  editor.insertTextAtCursor("unsent");
  const path = "/tmp/pi-clipboard-history.png";
  editor.insertTextAtCursor(path);
  editor.render(90);
  editor.handleInput("\x01");
  editor.handleInput("\x1b[A"); assert.equal(editor.getText(), "older"); assert.equal(editor.currentAttachments().length, 0);
  editor.handleInput("\x1b[B"); assert.equal(editor.getText(), `unsent ${path}`);
  assert.equal(editor.currentAttachments().length, 1);
  assert.deepEqual(editor.getLines(), ["unsent"]);
});

const catalog: Reference[] = [
  { kind: "skill", value: "$how", label: "how", description: "Explain runtime architecture" },
  { kind: "tool", value: "@tool:read", label: "read", description: "builtin · Read file contents" },
];
test("references search descriptions, preserve native completion and insert without submitting", async () => {
  const provider = referenceCompletion(new CombinedAutocompleteProvider([{ name: "help", description: "help" }], tmpdir()), () => catalog);
  const signal = new AbortController().signal;
  assert.equal((await provider.getSuggestions(["$arch"], 0, 5, { signal }))?.items[0]?.value, "$how");
  assert.equal((await provider.getSuggestions(["@tool:read"], 0, 10, { signal }))?.items[0]?.value, "@tool:read");
  assert.equal((await provider.getSuggestions(["/hel"], 0, 4, { signal }))?.items[0]?.value, "help");
  const { editor, sent } = fixture();
  editor.setAutocompleteProvider(provider);
  editor.handleInput("$"); editor.handleInput("h"); await tick();
  assert.equal(editor.isShowingAutocomplete(), true);
  editor.handleInput("\r"); assert.equal(editor.getText(), "$how "); assert.deepEqual(sent, []);
  editor.setText("/hel"); editor.handleInput("\t"); await tick();
  editor.handleInput("\r"); assert.deepEqual(sent, []);
});

test("skill references read only registered skills, dedupe, preserve missing refs and shell text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composer-skill-"));
  try {
    const path = join(dir, "SKILL.md");
    await writeFile(path, "Explain the actual runtime.");
    const skills: Reference[] = [{ ...catalog[0], path }, { kind: "skill", value: "$why", label: "why", path, description: "Explain history" }];
    const text = await expandSkillReferences("Use $how and $how.", skills);
    assert.ok(text.includes("Explain the actual runtime."));
    assert.equal(text.split("Explain the actual runtime.").length, 2);
    assert.equal(await expandSkillReferences(text, skills), text);
    const withBodyReference = `${text}\n\nSkill body mentions $why.`;
    assert.equal(await expandSkillReferences(withBodyReference, skills), withBodyReference);
    assert.ok(text.includes(dir));
    assert.equal(await expandSkillReferences("!echo $how", skills), "!echo $how");
    assert.equal(await expandSkillReferences("$missing", skills), "$missing");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real images decode, corrupt/missing/oversized previews reject without altering submission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composer-image-"));
  try {
    const path = join(dir, "image.png");
    await writeFile(path, png);
    const store = new Attachments(); const token = store.insert(path); const attachment = store.inText(token)[0];
    assert.deepEqual((await readPreview(attachment)).dimensions, { widthPx: 1, heightPx: 1 });
    await writeFile(path, "not an image"); await assert.rejects(readPreview(attachment), /invalid/);
    await writeFile(path, Buffer.alloc(11 * 1024 * 1024)); await assert.rejects(readPreview(attachment), /10 MiB/);
    await rm(path); await assert.rejects(readPreview(attachment));
    assert.equal(store.expand(token), path);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("composer renders bounded lines at narrow sizes and exposes its stash state", () => {
  const { editor } = fixture(18);
  editor.setText("draft"); editor.swapStash();
  assert.ok(editor.render(90).join("\n").includes("Restore draft"));
  editor.insertTextAtCursor("/tmp/pi-clipboard-narrow.png");
  for (const width of [1, 8, 30, 90]) for (const line of editor.render(width)) assert.ok(visibleWidth(line) <= width);
});

test("extension registers one editor, immediate stash controls and stays inert in RPC", () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const shortcuts: string[] = [];
  const commands: string[] = [];
  const pi = { on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, fn),
    registerShortcut: (name: string) => shortcuts.push(name), registerCommand: (name: string) => commands.push(name),
  } as unknown as ExtensionAPI;
  composer(pi);
  assert.ok(shortcuts.includes("alt+s")); assert.ok(shortcuts.includes("alt+i")); assert.ok(commands.includes("stash"));
  let installs = 0;
  const ctx = { hasUI: true, mode: "rpc", ui: { setEditorComponent: () => { installs++; } } } as unknown as ExtensionContext;
  handlers.get("session_start")?.({}, ctx); assert.equal(installs, 0);
});
