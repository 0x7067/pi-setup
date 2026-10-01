import type {
  Message,
  TextContent,
  ToolCall,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentOrigin } from "./domain.ts";

export const BTW_TITLE_MAX_LENGTH = 60;

const BTW_CONTEXT_MAX_ENTRIES = 12;
const BTW_CONTEXT_MAX_BYTES = 6 * 1024;
const BTW_LINE_MAX_LENGTH = 240;
const BTW_ARGS_PREVIEW_MAX_LENGTH = 160;

/** Build a compact dashboard title from the first non-empty prompt line. */
export function deriveBtwTitle(prompt: string) {
  const firstLine = prompt
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const title = firstLine?.replace(/\s+/g, " ") ?? "";
  if (!title) return "by the way";
  const codePoints = Array.from(title);
  if (codePoints.length <= BTW_TITLE_MAX_LENGTH) return title;
  return `${codePoints.slice(0, BTW_TITLE_MAX_LENGTH - 1).join("")}…`;
}

/** User asides remain visible in the dashboard but hidden from model tools. */
export function isModelVisible(snap: { readonly origin: SubagentOrigin }) {
  return snap.origin === "model";
}

// --- Parent-session context preamble -------------------------------------------

function firstNonEmptyLine(text: string, max = BTW_LINE_MAX_LENGTH) {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function userText(message: UserMessage) {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextContent => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function argsPreview(args: ToolCall["arguments"]) {
  try {
    const text = JSON.stringify(args);
    if (!text || text === "{}") return undefined;
    return text.length > BTW_ARGS_PREVIEW_MAX_LENGTH
      ? `${text.slice(0, BTW_ARGS_PREVIEW_MAX_LENGTH - 1)}…`
      : text;
  } catch {
    return undefined;
  }
}

function summarizeMessage(message: Message): string | undefined {
  switch (message.role) {
    case "user": {
      const line = firstNonEmptyLine(userText(message));
      return line ? `user: ${line}` : undefined;
    }
    case "assistant": {
      const out: string[] = [];
      let text = "";
      for (const part of message.content) {
        if (part.type === "text") {
          text += part.text;
        } else if (part.type === "toolCall") {
          const preview = argsPreview(part.arguments);
          out.push(`  → ${part.name}${preview ? `(${preview})` : ""}`);
        }
      }
      const line = firstNonEmptyLine(text);
      const lines: string[] = [];
      if (line) lines.push(`assistant: ${line}`);
      lines.push(...out);
      return lines.length ? lines.join("\n") : undefined;
    }
    case "toolResult": {
      const text = message.content
        .filter((p): p is TextContent => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      const line = firstNonEmptyLine(text);
      if (!line) return undefined;
      const tag = message.isError ? "error" : "result";
      return `${tag}(${message.toolName}): ${line}`;
    }
  }
}

/** Narrow an AgentMessage (which may include custom message types) to Message. */
function isMessage(message: AgentMessage): message is Message {
  const role = (message as Message).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

/**
 * Build a compact "current session" preamble for a /btw aside from the parent
 * session's recent transcript. The aside runs in its own session with no
 * inherited context, so without this it cannot answer questions about what
 * the main agent is doing ("is X stuck?"). Returns an empty string when there
 * is nothing to summarize or the session has no entries yet.
 */
export function buildBtwContextPreamble(
  sessionManager: ExtensionContext["sessionManager"],
) {
  const entries = sessionManager.buildContextEntries();
  const messages: Message[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (isMessage(message)) messages.push(message);
  }

  const recent = messages.slice(-BTW_CONTEXT_MAX_ENTRIES);
  const lines: string[] = [];
  let bytes = 0;
  for (const message of recent) {
    const line = summarizeMessage(message);
    if (!line) continue;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > BTW_CONTEXT_MAX_BYTES) break;
    lines.push(line);
    bytes += lineBytes;
  }
  if (lines.length === 0) return "";
  return [
    "Current session context (the main agent's recent activity):",
    ...lines,
  ].join("\n");
}
