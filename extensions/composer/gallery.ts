import { truncateToWidth, type ImageTheme } from "@earendil-works/pi-tui";
import { AttachmentPreview, type Attachment } from "./attachments.ts";

/** Pi crops and cleans up one image per terminal row; keep thumbnails on separate rows. */
export class AttachmentGallery {
  private previews = new Map<string, AttachmentPreview>();
  private rowOwners: number[] = [];
  private changed: () => void;
  constructor(changed: () => void) { this.changed = changed; }

  render(images: readonly Attachment[], { selected, focused, width, budget, theme }: {
    selected: number; focused: boolean; width: number; budget: number; theme: ImageTheme;
  }): string[] {
    const multiple = images.length > 1;
    const capacity = Math.min(images.length, Math.max(1, Math.floor((budget + 1) / 3)));
    const start = Math.max(0, selected - capacity + 1);
    const visible = images.slice(start, start + capacity);
    const height = multiple ? Math.min(5, Math.max(1, Math.floor((budget - capacity * 2 + 1) / capacity))) : Math.min(8, Math.max(1, budget - (focused ? 1 : 0)));
    const kept = new Set<string>();
    const output: string[] = [];
    const owners: number[] = [];
    for (const [offset, image] of visible.entries()) {
      const index = start + offset;
      const key = `${index}:${image.token}`;
      kept.add(key);
      let preview = this.previews.get(key);
      if (!preview) { preview = new AttachmentPreview(this.changed); this.previews.set(key, preview); }
      if (offset) output.push("");
      // A caption marks the selection; a lone unfocused image needs neither.
      if (multiple || focused) output.push(theme.fallbackColor(truncateToWidth(`${focused && index === selected ? "▸ " : ""}${index + 1} / ${images.length}`, width, "")));
      output.push(...preview.render(image, width, height, theme));
      while (owners.length < output.length) owners.push(index);
    }
    for (const key of this.previews.keys()) if (!kept.has(key)) this.previews.delete(key);
    this.rowOwners = owners;
    return output;
  }

  /** Image index rendered on a gallery row from the last render, if any. */
  imageAt(row: number): number | undefined { return this.rowOwners[row]; }

  invalidate(): void { for (const preview of this.previews.values()) preview.invalidate(); }
}
