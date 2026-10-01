import { AsyncLocalStorage } from "node:async_hooks";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, truncateToWidth, type AutocompleteProvider, type EditorTheme,
  type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Attachments, type Attachment } from "./attachments.ts";
import { DraftBuffer } from "./draft.ts";
import { AttachmentGallery } from "./gallery.ts";

type WorkingIndicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
type ComposerOptions = { inspect: (attachment: Attachment) => void; isWorking: () => boolean };

/** A native buffer per draft keeps cursor, kill ring, paste registry and undo together. */
export class ComposerEditor extends CustomEditor {
  private active: DraftBuffer;
  private stashed?: DraftBuffer;
  private buffers = new Set<DraftBuffer>();
  private draftHistory: string[] = [];
  private provider?: AutocompleteProvider;
  private indicator?: WorkingIndicator;
  private attachments = new Attachments();
  private clipboardTarget = new AsyncLocalStorage<DraftBuffer>();
  private gallery: AttachmentGallery;
  private attachmentFocus = false;
  private selected = 0;
  private insertedRows = { start: 0, count: 0 };
  private options: ComposerOptions;
  private editorTheme: EditorTheme;
  private appKeys: KeybindingsManager;

  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, options: ComposerOptions) {
    super(tui, theme, keys, { embedWorkingStatus: true });
    this.editorTheme = theme;
    this.appKeys = keys;
    this.options = options;
    this.gallery = new AttachmentGallery(() => tui.requestRender());
    this.active = this.createBuffer();
  }

  private createBuffer(): DraftBuffer {
    const draft = new DraftBuffer(this.tui, this.editorTheme, this.appKeys, this.attachments);
    for (const entry of this.draftHistory) draft.addToHistory(entry);
    if (this.provider) draft.setAutocompleteProvider(this.provider);
    draft.setPaddingX(this.getPaddingX());
    draft.setAutocompleteMaxVisible(this.getAutocompleteMaxVisible());
    draft.label = () => this.footerLabel();
    draft.onImagesAdded = () => {
      if (draft === this.active) this.selected = draft.images.length - 1;
      this.tui.requestRender();
    };
    this.buffers.add(draft);
    return draft;
  }

  private wireBuffer(): void {
    const buffer = this.active;
    buffer.actionHandlers = this.actionHandlers;
    buffer.onEscape = this.onEscape;
    buffer.onCtrlD = () => {
      if (buffer.images.length) this.focusAttachments();
      else this.onCtrlD?.();
    };
    buffer.onPasteImage = () => this.clipboardTarget.run(buffer, () => this.onPasteImage?.());
    buffer.onExtensionShortcut = this.onExtensionShortcut;
    buffer.onChange = () => this.onChange?.(this.getExpandedText());
    buffer.onSubmit = (text) => this.onSubmit?.(text);
    buffer.disableSubmit = this.disableSubmit;
    buffer.focused = this.focused && !this.attachmentFocus;
    buffer.borderColor = this.borderColor;
    buffer.setWorkingStatusIndicator(this.indicator);
  }

  swapStash(): void {
    if (this.active.isShowingAutocomplete()) Editor.prototype.handleInput.call(this.active, "\x1b");
    if (!this.active.hasContent() && !this.stashed) return;
    const previous = this.active;
    this.active = this.stashed ?? this.createBuffer();
    this.stashed = previous.hasContent() ? previous : undefined;
    if (!this.stashed) this.buffers.delete(previous);
    this.attachmentFocus = false;
    this.selected = 0;
    this.wireBuffer();
    this.onChange?.(this.getExpandedText());
    this.tui.requestRender();
  }

  hasStash(): boolean { return this.stashed !== undefined; }
  expandPastes(): void { this.active.expandPastes(); this.tui.requestRender(); }
  focusAttachments(): void {
    this.attachmentFocus = !this.attachmentFocus && this.currentAttachments().length > 0;
    this.tui.requestRender();
  }
  currentAttachments(): Attachment[] { return [...this.active.images]; }

  removeSelectedAttachment(): void {
    this.active.removeImage(this.selected);
    const remaining = this.currentAttachments().length;
    this.selected = Math.min(this.selected, Math.max(0, remaining - 1));
    if (!remaining) this.attachmentFocus = false;
    this.tui.requestRender();
  }

  /** Backspace with nothing left to erase before the cursor removes the newest image instead. */
  private removeLastAttachmentAtStart(): boolean {
    const cursor = this.active.getCursor();
    if (cursor.line || cursor.col || !this.active.images.length || this.active.isShowingAutocomplete()) return false;
    this.selected = this.active.images.length - 1;
    this.removeSelectedAttachment();
    return true;
  }

  private handleAttachmentInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "tab")) this.attachmentFocus = false;
    else if (matchesKey(data, "left") || matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "right") || matchesKey(data, "down")) this.selected = Math.min(this.currentAttachments().length - 1, this.selected + 1);
    else if (matchesKey(data, "backspace") || matchesKey(data, "delete")) this.removeSelectedAttachment();
    else if (matchesKey(data, "enter")) {
      const selected = this.currentAttachments()[this.selected];
      if (selected) this.options.inspect(selected);
    } else if (this.appKeys.matches(data, "app.clear")) {
      this.attachmentFocus = false;
      this.active.handleInput(data);
    }
    this.tui.requestRender();
  }

  override handleInput(data: string): void {
    this.wireBuffer();
    // Prefer Pi's extension-shortcut dispatch when wired, but stay
    // self-sufficient: the forwarder is installed during
    // setCustomEditorComponent and can be stale relative to session_start
    // ordering, which leaves correct Alt+S bytes swallowed as a no-op.
    if (this.onExtensionShortcut?.(data)) return;
    if (matchesKey(data, "alt+s")) { this.swapStash(); return; }
    if (matchesKey(data, "alt+i")) { this.focusAttachments(); return; }
    if (matchesKey(data, "alt+p")) { this.expandPastes(); return; }
    if (this.attachmentFocus) {
      this.handleAttachmentInput(data);
      return;
    }
    if (matchesKey(data, "backspace") && this.removeLastAttachmentAtStart()) return;
    if (this.active.isShowingAutocomplete() && this.appKeys.matches(data, "tui.select.confirm")) {
      Editor.prototype.handleInput.call(this.active, "\t");
      return;
    }
    this.active.handleInput(data);
  }

  override getText(): string { return this.active.serialize(false); }
  override getExpandedText(): string { return this.active.serialize(); }
  override getLines(): string[] { return this.active.getLines(); }
  override getCursor(): { line: number; col: number } { return this.active.getCursor(); }
  override setText(text: string): void {
    if (!this.active.setTextPreservingPastes(text)) this.active.setText(text);
    this.attachmentFocus = false;
    this.selected = 0;
  }
  override insertTextAtCursor(text: string): void {
    const target = this.clipboardTarget.getStore() ?? this.active;
    if (!this.buffers.has(target)) return;
    const images = this.attachments.insertImages(text);
    if (images) target.addImages(images);
    else target.insertTextAtCursor(text);
    if (target === this.active) this.selected = Math.max(0, target.images.length - 1);
    this.tui.requestRender();
  }
  override addToHistory(text: string): void {
    this.draftHistory.push(text);
    for (const buffer of this.buffers) buffer.addToHistory(text);
  }
  override isShowingAutocomplete(): boolean { return this.active.isShowingAutocomplete(); }
  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.provider = provider;
    for (const buffer of this.buffers) buffer.setAutocompleteProvider(provider);
  }
  override setPaddingX(padding: number): void {
    super.setPaddingX(padding);
    for (const buffer of this.buffers) buffer.setPaddingX(padding);
  }
  override setAutocompleteMaxVisible(count: number): void {
    super.setAutocompleteMaxVisible(count);
    for (const buffer of this.buffers) buffer.setAutocompleteMaxVisible(count);
  }
  override setWorkingStatusIndicator(indicator: WorkingIndicator): void { this.indicator = indicator; }
  override invalidate(): void {
    for (const buffer of this.buffers) buffer.invalidate();
    this.gallery.invalidate();
  }

  private footerLabel(): string {
    const stash = this.hasStash() ? " · Draft stashed" : "";
    if (!this.active.hasContent() && !this.attachmentFocus && !this.active.isShowingAutocomplete()) {
      return `Type a message · $ Skills · @ Files, tools · Ctrl+G Editor${this.hasStash() ? " · Alt+S Restore draft" : ""}`;
    }
    const count = this.active.images.length;
    if (this.attachmentFocus) return `Image ${this.selected + 1}/${count} · ← → Select · ↵ Inspect · ⌫ Remove · Esc Type${stash}`;
    if (this.active.isShowingAutocomplete()) return `↑ ↓ Choose · ↵/Tab Insert · Esc Close${stash}`;
    const send = this.options.isWorking() ? "Steer" : "Send";
    const hint = this.appKeys.getKeys("tui.input.submit").map((key) => key === "enter" ? "↵" : key).join("/");
    const cursor = this.active.getCursor();
    const images = count ? `Alt+I ${count === 1 ? "Image" : `${count} Images`}${cursor.line || cursor.col ? "" : " · ⌫ Remove"}` : `Alt+S ${this.hasStash() ? "Swap" : "Stash"}`;
    return `${hint} ${send} · ⇧↵ New line · ${images}${stash}`;
  }

  override render(width: number): string[] {
    this.wireBuffer();
    const lines = this.active.render(width).map((line) => truncateToWidth(line, width, ""));
    const images = this.currentAttachments();
    this.selected = Math.max(0, Math.min(this.selected, images.length - 1));
    const budget = Math.max(1, Math.min(14, Math.floor(this.tui.terminal.rows / 2)) - lines.length);
    const gallery = this.gallery.render(images, {
      selected: this.selected, focused: this.attachmentFocus, width, budget,
      theme: { fallbackColor: (text) => this.editorTheme.selectList.description(truncateToWidth(text, width, "")) },
    });
    // Images occupy the area above the native text buffer, not below its cursor.
    this.insertedRows = { start: 1, count: gallery.length };
    lines.splice(1, 0, ...gallery);
    return lines;
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { start, count } = this.insertedRows;
    if (count && event.y >= start && event.y < start + count) {
      if (event.type !== "click" || event.button !== "left") return { handled: true };
      const index = this.gallery.imageAt(event.y - start) ?? -1;
      const image = this.currentAttachments()[index];
      if (!image) return { handled: true, focus: true };
      // First click selects, a second click on the selected image inspects it.
      if (this.attachmentFocus && this.selected === index) this.options.inspect(image);
      else { this.attachmentFocus = true; this.selected = index; }
      this.tui.requestRender();
      return { handled: true, focus: true };
    }
    return this.active.handleMouse(event.y >= start + count ? { ...event, y: event.y - count } : event);
  }
}
