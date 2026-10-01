import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { Image, getImageDimensions, stripTerminalSequences, type ImageDimensions, type ImageTheme } from "@earendil-works/pi-tui";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
export type Attachment = { token: string; path: string; name: string; mime: string };
type Preview = { data: string; dimensions: ImageDimensions };

function escapeRegExp(text: string): string { return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"); }
function parseSinglePath(text: string): string | undefined {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote === '"') {
    try { const value: unknown = JSON.parse(trimmed); return typeof value === "string" ? value : undefined; }
    catch { return; }
  }
  if (quote === "'") {
    if (trimmed.length < 2 || trimmed.at(-1) !== quote) return;
    const body = trimmed.slice(1, -1);
    if (body.includes(quote)) return;
    return body;
  }
  if (/(^|[^\\])\s/.test(trimmed)) return;
  return trimmed.replace(/\\ /g, " ");
}
function replaceStandalonePath(text: string, path: string, token: string): string {
  return text.replace(new RegExp(`(^|\\s)${escapeRegExp(path)}(?=$|\\s)`, "g"), (_match, prefix: string) => `${prefix}${token}`);
}

export class Attachments {
  private entries: Attachment[] = [];

  /** Native clipboard insertion and a single dropped image become an editable reference. */
  insert(text: string): string { return this.insertImage(text) ?? this.encode(text); }

  insertImage(text: string): string | undefined {
    const path = parseSinglePath(text);
    const mime = path ? MIME[extname(path).toLowerCase()] : undefined;
    if (!path || !mime || !isAbsolute(path) || path.includes("\n")) return;
    return this.imageForPath(path, mime).token;
  }

  private imageForPath(path: string, mime: string): Attachment {
    let entry = this.entries.find((a) => a.path === path);
    if (!entry) {
      entry = { token: `[image #${this.entries.length + 1}:${randomUUID().replaceAll("-", "").slice(0, 12)}]`, path, mime, name: stripTerminalSequences(basename(path)).replace(/[\x00-\x1f\x7f]/g, "") };
      this.entries.push(entry);
    }
    return entry;
  }

  insertImages(text: string): Attachment[] | undefined {
    const parts = [...text.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|(?:\\.|[^\s"'\\])+/g)];
    if (!parts.length) return;
    let end = 0;
    const paths: Array<{ path: string; mime: string }> = [];
    for (const part of parts) {
      if (text.slice(end, part.index).trim() || (paths.length && part.index === end)) return;
      end = part.index + part[0].length;
      const path = parseSinglePath(part[0]);
      const mime = path ? MIME[extname(path).toLowerCase()] : undefined;
      if (!path || !mime || !isAbsolute(path) || /[\r\n]/.test(path)) return;
      paths.push({ path, mime });
    }
    if (text.slice(end).trim()) return;
    return paths.map(({ path, mime }) => this.imageForPath(path, mime));
  }

  extract(text: string): { text: string; images: Attachment[] } {
    let encoded = this.encode(text);
    const images = this.inText(encoded);
    for (const image of images) encoded = encoded.replace(image.token, "");
    return { text: images.length && !encoded.trim() ? "" : encoded, images };
  }

  serialize(text: string, images: readonly Attachment[]): string {
    if (!images.length) return text;
    const paths = images.map((image) => /\s|["'\\]/.test(image.path) ? JSON.stringify(image.path) : image.path).join(" ");
    return text + (text && !/\s$/.test(text) ? " " : "") + paths;
  }

  encode(text: string): string {
    for (const a of [...this.entries].sort((a, b) => b.path.length - a.path.length)) {
      text = replaceStandalonePath(text.replaceAll(JSON.stringify(a.path), a.token), a.path, a.token);
    }
    return text.replace(/(^|\s)(\/[^\s"'`]*pi-clipboard-[^\s"'`]*\.(?:png|jpe?g|gif|webp))(?=$|\s)/gi,
      (_match, prefix: string, path: string) => `${prefix}${this.insertImage(path) ?? path}`);
  }

  expand(text: string): string {
    for (const a of this.entries) text = text.replaceAll(a.token, /\s/.test(a.path) ? JSON.stringify(a.path) : a.path);
    return text;
  }

  inText(text: string): Attachment[] {
    const matches: Array<{ index: number; attachment: Attachment }> = [];
    for (const attachment of this.entries) {
      for (let index = text.indexOf(attachment.token); index >= 0; index = text.indexOf(attachment.token, index + attachment.token.length)) {
        matches.push({ index, attachment });
      }
    }
    return matches.sort((a, b) => a.index - b.index).map((match) => match.attachment);
  }
}

export async function readPreview(attachment: Attachment): Promise<Preview> {
  const file = await open(attachment.path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_PREVIEW_BYTES) throw new Error("Preview unavailable: not a regular image under 10 MiB");
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_PREVIEW_BYTES + 1));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const data = bytes.subarray(0, bytesRead).toString("base64");
    const dimensions = getImageDimensions(data, attachment.mime);
    if (!dimensions) throw new Error("Preview unavailable: invalid or unsupported image");
    return { data, dimensions };
  } finally { await file.close(); }
}

export class AttachmentPreview {
  private current?: { path: string; result?: Preview; error?: string };
  private image?: { key: string; component: Image };
  private changed: () => void;
  constructor(changed: () => void) { this.changed = changed; }

  render(attachment: Attachment, width: number, height: number, theme: ImageTheme): string[] {
    if (this.current?.path !== attachment.path) {
      const request: NonNullable<AttachmentPreview["current"]> = { path: attachment.path };
      this.current = request;
      this.image = undefined;
      void readPreview(attachment).then((result) => { request.result = result; }, (error: unknown) => {
        request.error = error instanceof Error && "code" in error ? `Preview unavailable (${String(error.code)})`
          : error instanceof Error ? error.message : "Preview unavailable";
      }).finally(() => { if (this.current === request) this.changed(); });
    }
    if (this.current.error) return [theme.fallbackColor(this.current.error)];
    const preview = this.current.result;
    if (!preview) return [theme.fallbackColor("Loading preview…")];
    const key = `${width}:${height}`;
    if (this.image?.key !== key) this.image = { key, component: new Image(preview.data, attachment.mime, theme,
      { maxWidthCells: width, maxHeightCells: height }, preview.dimensions) };
    return this.image.component.render(width);
  }

  invalidate(): void { this.image?.component.invalidate(); }
}
