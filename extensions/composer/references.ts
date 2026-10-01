import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";

export type Reference = AutocompleteItem & { kind: "skill" | "tool"; path?: string };

function escapeRegExp(text: string): string { return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"); }

export function references(pi: ExtensionAPI): Reference[] {
  const skills: Reference[] = pi.getCommands().filter((c) => c.source === "skill").map((c) => ({
    kind: "skill", value: `$${c.name.replace(/^skill:/, "")}`,
    label: c.name.replace(/^skill:/, ""), description: c.description, path: c.sourceInfo.path,
  }));
  const tools: Reference[] = pi.getAllTools().map((t) => ({
    kind: "tool", value: `@tool:${t.name}`, label: t.name,
    description: `${t.sourceInfo.source} · ${t.description}`,
  }));
  return [...skills, ...tools];
}

export function referenceCompletion(base: AutocompleteProvider, catalog: () => Reference[]): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(base.triggerCharacters ?? []), "$", "@", "/"])],
    async getSuggestions(lines, line, col, options) {
      if (lines[0]?.startsWith("!")) return base.getSuggestions(lines, line, col, options);
      const token = (lines[line] ?? "").slice(0, col).match(/(?:^|\s)(\$[^\s$]*|@(?:skill:|tool:)?[^\s@]*)$/)?.[1];
      if (!token) return base.getSuggestions(lines, line, col, options);
      const kind = token.startsWith("$") || token.startsWith("@skill:") ? "skill" : token.startsWith("@tool:") ? "tool" : undefined;
      const query = token.replace(/^(?:\$|@(?:skill:|tool:)?)/, "");
      const items = fuzzyFilter(catalog().filter((r) => !kind || r.kind === kind), query,
        (r) => `${r.label} ${r.description ?? ""}`).slice(0, 8).map((r) => ({
          ...r, label: `${r.kind === "skill" ? "skill" : "tool "}  ${r.label}`,
        }));
      if (kind) return items.length ? { prefix: token, items } : null;
      const files = await base.getSuggestions(lines, line, col, options);
      return { prefix: token, items: [...(files?.items ?? []).slice(0, 5), ...items].slice(0, 10) };
    },
    applyCompletion(lines, line, col, item, prefix) {
      if (!item.value.startsWith("$") && !item.value.startsWith("@tool:")) {
        return base.applyCompletion(lines, line, col, item, prefix);
      }
      const result = [...lines];
      const before = (lines[line] ?? "").slice(0, col - prefix.length);
      result[line] = `${before}${item.value} ${(lines[line] ?? "").slice(col)}`;
      return { lines: result, cursorLine: line, cursorCol: before.length + item.value.length + 1 };
    },
    shouldTriggerFileCompletion: (lines, line, col) => base.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
  };
}

/** Only the host's loaded, trust-filtered skill catalog can supply a file path. */
export async function expandSkillReferences(text: string, catalog: readonly Reference[]): Promise<string> {
  if (text.startsWith("!") || text.startsWith("/")) return text;
  const referenceText = text.split(/\n\nSkill \$[a-z0-9][a-z0-9-]* \(/, 1)[0] ?? text;
  const names = new Set([...referenceText.matchAll(/(?:^|\s)\$([a-z0-9][a-z0-9-]*)(?=$|[\s.,;:!?])/g)].map((m) => `$${m[1]}`));
  const selected = catalog.filter((r) => r.kind === "skill" && r.path && names.has(r.value) && !new RegExp(`(^|\\n)Skill ${escapeRegExp(r.value)} \\(`).test(text));
  if (!selected.length) return text;
  const blocks = await Promise.all(selected.map(async (r) => {
    if (!r.path) throw new Error(`Skill ${r.label} has no source path`);
    const content = await readFile(r.path, "utf8");
    return `Skill ${r.value} (${r.path}). Resolve relative references from ${dirname(r.path)}:\n\n${content}`;
  }));
  return `${text}\n\n${blocks.join("\n\n")}`;
}
