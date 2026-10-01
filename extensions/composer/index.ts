import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { AttachmentPreview } from "./attachments.ts";
import { ComposerEditor } from "./editor.ts";
import { expandSkillReferences, referenceCompletion, references } from "./references.ts";

export default function composer(pi: ExtensionAPI) {
  let editor: ComposerEditor | undefined;
  pi.registerShortcut("alt+s", { description: "Stash / restore / swap the current draft", handler: async () => editor?.swapStash() });
  pi.registerShortcut("alt+i", { description: "Focus image attachments", handler: async () => editor?.focusAttachments() });
  pi.registerShortcut("alt+p", { description: "Expand pasted text (undo to collapse again)", handler: async () => editor?.expandPastes() });
  pi.registerCommand("stash", { description: "Restore or swap the immediate draft stash (Alt+S to stash while typing)",
    handler: async () => editor?.swapStash() });
  pi.registerCommand("composer", { description: "Composer keyboard help", handler: async (_args, ctx) => {
    ctx.ui.notify("$ skills · @ files/references · @tool: tools · Alt+S stash/swap · Alt+I images (⌫ at start removes) · Alt+P expand pastes · Ctrl+G external editor", "info");
  } });

  pi.on("session_start", (_event, ctx) => {
    editor = undefined;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((base) => referenceCompletion(base, () => references(pi)));
    ctx.ui.setEditorComponent((tui, theme, keys) => {
      editor = new ComposerEditor(tui, theme, keys, {
        isWorking: () => !ctx.isIdle(),
        inspect: (attachment) => {
          void ctx.ui.custom<void>((overlayTui, overlayTheme, _kb, done) => {
            const preview = new AttachmentPreview(() => overlayTui.requestRender());
            return {
              render: (width) => [overlayTheme.fg("accent", truncateToWidth(`${attachment.name} · esc close`, width)),
                ...preview.render(attachment, width, Math.max(1, Math.floor(overlayTui.terminal.rows * 0.7) - 2), {
                  fallbackColor: (s) => overlayTheme.fg("muted", truncateToWidth(s, width)),
                })],
              handleInput: (data) => { if (matchesKey(data, "escape") || matchesKey(data, "enter")) done(); },
              invalidate: () => preview.invalidate(),
            };
          }, { overlay: true, overlayOptions: { width: "85%", maxHeight: "80%" } }).catch((error: unknown) => {
            ctx.ui.notify(`Image inspection failed: ${String(error)}`, "error");
          });
        },
      });
      return editor;
    });
  });
  pi.on("input", async (event) => {
    if (event.source !== "interactive") return { action: "continue" };
    const text = await expandSkillReferences(event.text, references(pi));
    return text === event.text ? { action: "continue" } : { action: "transform", text, images: event.images };
  });
  pi.on("session_shutdown", () => { editor = undefined; });
}
