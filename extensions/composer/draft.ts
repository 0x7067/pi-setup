import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { Attachments, type Attachment } from "./attachments.ts";

type NativeBuffer = {
  state: { lines: string[]; composerAttachments?: Attachment[] };
  pastes: Map<number, string>;
  setTextInternal: (text: string, placement?: "start" | "end") => void;
  handlePaste: (text: string) => void;
  submitValue: () => void;
  cancelAutocomplete: () => void;
  exitHistoryBrowsing: () => void;
  pushUndoSnapshot: () => void;
  lastAction: unknown;
};

function nativeBuffer(buffer: DraftBuffer): NativeBuffer {
  const editor = buffer as unknown as Partial<NativeBuffer>;
  if (!editor.state || !Array.isArray(editor.state.lines) || !(editor.pastes instanceof Map) ||
    typeof editor.setTextInternal !== "function" || typeof editor.cancelAutocomplete !== "function" ||
    typeof editor.exitHistoryBrowsing !== "function" || typeof editor.pushUndoSnapshot !== "function" ||
    typeof editor.handlePaste !== "function" || typeof editor.submitValue !== "function") {
    throw new Error("Unsupported Pi editor snapshot API for composer attachments");
  }
  return editor as NativeBuffer;
}

/** Pi deep-clones state for undo and history. Keep images there, never in editable text. */
export class DraftBuffer extends CustomEditor {
  label = () => "";
  onImagesAdded?: () => void;
  private store: Attachments;
  private native: NativeBuffer;
  private footerColor: (text: string) => string;
  private restoringImages?: Attachment[];

  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, store: Attachments) {
    super(tui, theme, keys, { embedWorkingStatus: true });
    this.store = store;
    const editor = nativeBuffer(this);
    this.native = editor;
    this.footerColor = theme.selectList.description;
    editor.state.composerAttachments = [];
    const setText = editor.setTextInternal.bind(this);
    // Native history uses this setter; external editing and queue restoration do too.
    editor.setTextInternal = (text, placement) => {
      const draft = this.restoringImages === undefined ? store.extract(text) : { text, images: this.restoringImages };
      editor.state.composerAttachments = draft.images;
      setText(draft.text, placement);
    };
    const paste = editor.handlePaste.bind(this);
    editor.handlePaste = (text) => {
      const images = store.insertImages(text);
      if (images) this.addImages(images);
      else paste(text);
    };
    const submit = editor.submitValue.bind(this);
    editor.submitValue = () => {
      const images = this.images;
      const onSubmit = this.onSubmit;
      // Native submission clears its state before calling onSubmit.
      this.onSubmit = (text) => onSubmit?.(store.serialize(text, images));
      try { submit(); } finally { this.onSubmit = onSubmit; void this.images; }
    };
  }

  get images(): Attachment[] { return this.native.state.composerAttachments ??= []; }
  hasContent(): boolean { return Boolean(this.getText() || this.images.length); }
  serialize(expanded = true): string {
    return this.store.serialize(expanded ? this.getExpandedText() : this.getText(), this.images);
  }

  addImages(images: Attachment[]): void {
    this.replaceImages([...this.images, ...images]);
    this.onImagesAdded?.();
  }

  removeImage(index: number): void {
    if (this.images[index]) this.replaceImages(this.images.filter((_image, i) => i !== index));
  }

  private replaceImages(images: Attachment[]): void {
    const editor = this.native;
    editor.cancelAutocomplete();
    editor.exitHistoryBrowsing();
    editor.lastAction = null;
    editor.pushUndoSnapshot();
    editor.state.composerAttachments = images;
    this.onChange?.(this.getText());
  }

  setTextPreservingPastes(text: string): boolean {
    const editor = this.native;
    const draft = this.store.extract(text);
    const normalized = draft.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    if (![...normalized.matchAll(/\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g)].some((match) => editor.pastes.has(Number(match[1])))) return false;
    editor.cancelAutocomplete();
    editor.exitHistoryBrowsing();
    editor.lastAction = null;
    if (this.getText() !== normalized || draft.images.length !== this.images.length || draft.images.some((image, i) => image.token !== this.images[i]?.token)) editor.pushUndoSnapshot();
    this.restoringImages = draft.images;
    try { editor.setTextInternal(normalized); } finally { this.restoringImages = undefined; }
    return true;
  }

  expandPastes(): void {
    this.restoringImages = this.images;
    try { super.setText(this.getExpandedText()); } finally { this.restoringImages = undefined; }
  }

  protected override renderBottomBorder(width: number, hidden: number): string {
    const label = truncateToWidth(` ${hidden ? `↓ ${hidden} more · ` : ""}${this.label()} `, width);
    return this.footerColor(label) + this.borderColor("─".repeat(Math.max(0, width - visibleWidth(label))));
  }
}
