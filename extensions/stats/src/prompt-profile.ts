import { createHash } from "node:crypto";

export interface PromptProfile {
  totalBytes: number;
  systemBytes: number;
  conversationBytes: number;
  toolBytes: number;
  otherBytes: number;
  messages: number;
  tools: number;
  stableHash: string;
}

export interface CacheUsage {
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  cacheWriteReported?: boolean;
}

export type CacheGuardStatus =
  "cold" | "changed" | "small" | "unsupported" | "healthy" | "warning";

export interface CacheGuardResult {
  status: CacheGuardStatus;
  cacheRate: number | null;
  reusableTokens: number;
  message: string;
}

const LARGE_STRING_CHARS = 1024 * 1024;
const HASH_SAMPLE_CHARS = 4096;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Count JSON-shaped data without materializing a second serialized payload. */
function createByteCounter() {
  const strings = new Map<string, number>();
  const objects = new WeakMap<object, number>();
  const visiting = new WeakSet<object>();
  const measure = (value: unknown): number => {
    if (value === null) return 4;
    if (typeof value === "string") {
      // Large strings are usually base64 images. Counting UTF-16 code units is
      // a bounded approximation that avoids flattening/duplicating huge ropes.
      if (value.length > LARGE_STRING_CHARS) return value.length + 2;
      const cached = strings.get(value);
      if (cached !== undefined) return cached;
      const size = Buffer.byteLength(value, "utf8") + 2;
      strings.set(value, size);
      return size;
    }
    if (typeof value === "number") {
      return Buffer.byteLength(Number.isFinite(value) ? String(value) : "null");
    }
    if (typeof value === "boolean") return value ? 4 : 5;
    if (typeof value === "bigint") return Buffer.byteLength(String(value)) + 2;
    if (typeof value !== "object") return 0;
    const cached = objects.get(value);
    if (cached !== undefined) return cached;
    if (visiting.has(value)) return 0;
    visiting.add(value);
    let total = 2;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (index > 0) total += 1;
        total += measure(item);
      });
    } else {
      let entries = 0;
      for (const [key, item] of Object.entries(value)) {
        if (
          item === undefined ||
          typeof item === "function" ||
          typeof item === "symbol"
        ) {
          continue;
        }
        if (entries > 0) total += 1;
        total += Buffer.byteLength(key, "utf8") + 3 + measure(item);
        entries += 1;
      }
    }
    visiting.delete(value);
    objects.set(value, total);
    return total;
  };
  return measure;
}

function hash(value: unknown) {
  const digest = createHash("sha256");
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object") {
      digest.update(`${typeof item}:`);
      if (typeof item === "string" && item.length > LARGE_STRING_CHARS) {
        digest.update(`large:${item.length}:`);
        const stride = Math.max(HASH_SAMPLE_CHARS, Math.floor(item.length / 4));
        for (let offset = 0; offset < item.length; offset += stride) {
          digest.update(item.slice(offset, offset + HASH_SAMPLE_CHARS));
        }
        digest.update(item.slice(-HASH_SAMPLE_CHARS));
      } else {
        digest.update(typeof item === "string" ? item : String(item));
      }
      digest.update(";");
      return;
    }
    if (seen.has(item)) {
      digest.update("cycle;");
      return;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      digest.update("[");
      for (const value of item) visit(value);
      digest.update("]");
      seen.delete(item);
      return;
    }
    digest.update("{");
    for (const [key, value] of Object.entries(item)) {
      digest.update(key);
      digest.update(":");
      visit(value);
    }
    digest.update("}");
    seen.delete(item);
  };
  visit(value);
  return digest.digest("hex");
}

function nonNegative(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function role(message: unknown) {
  return record(message)?.role;
}

/** Profile provider payload sections without retaining their prompt content. */
export function profileProviderPayload(payload: unknown): PromptProfile {
  const root = record(payload) ?? {};
  const rawMessages = Array.isArray(root.messages)
    ? root.messages
    : Array.isArray(root.input)
      ? root.input
      : Array.isArray(root.contents)
        ? root.contents
        : [];
  const instructionMessages = rawMessages.filter(
    (message) => role(message) === "system" || role(message) === "developer",
  );
  const conversation = rawMessages.filter(
    (message) => role(message) !== "system" && role(message) !== "developer",
  );
  const rootInstructions = [
    root.system,
    root.instructions,
    root.systemInstruction,
  ].filter((value) => value !== undefined);
  const instructions = [...rootInstructions, ...instructionMessages];
  const tools = Array.isArray(root.tools) ? root.tools : [];

  const measure = createByteCounter();
  const totalBytes = measure(payload);
  const systemBytes = measure(instructions);
  const conversationBytes = measure(conversation);
  const toolBytes = measure(tools);
  return {
    totalBytes,
    systemBytes,
    conversationBytes,
    toolBytes,
    otherBytes: Math.max(
      0,
      totalBytes - systemBytes - conversationBytes - toolBytes,
    ),
    messages: conversation.length,
    tools: tools.length,
    stableHash: hash({
      model: root.model,
      instructions,
      tools,
      cacheAffinity: {
        promptCacheKey: root.prompt_cache_key ?? root.promptCacheKey,
        sessionId: root.session_id ?? root.sessionId,
        user: root.user,
      },
    }),
  };
}

export function evaluateCacheGuard(
  usage: CacheUsage,
  options: {
    hadPriorRequest: boolean;
    stablePayload: boolean;
    supportsCache: boolean;
    minimumTokens?: number;
    minimumRate?: number;
  },
): CacheGuardResult {
  const input = nonNegative(usage.input);
  const cacheRead = nonNegative(usage.cacheRead);
  const reportedWrite =
    usage.cacheWriteReported === true ? nonNegative(usage.cacheWrite) : 0;
  const reusableTokens = input + cacheRead + reportedWrite;
  const cacheRate = reusableTokens > 0 ? cacheRead / reusableTokens : null;

  if (!options.supportsCache) {
    return {
      status: "unsupported",
      cacheRate,
      reusableTokens,
      message: "cache support has not been observed for this model",
    };
  }
  if (!options.hadPriorRequest) {
    return {
      status: "cold",
      cacheRate,
      reusableTokens,
      message: "cold request; no prior request for this provider/model",
    };
  }
  if (!options.stablePayload) {
    return {
      status: "changed",
      cacheRate,
      reusableTokens,
      message: "system prompt, tools, or model changed",
    };
  }
  if (reusableTokens < (options.minimumTokens ?? 4096)) {
    return {
      status: "small",
      cacheRate,
      reusableTokens,
      message: "request is below the cache guard threshold",
    };
  }

  const minimumRate = options.minimumRate ?? 0.8;
  if (cacheRate === null || cacheRate < minimumRate) {
    return {
      status: "warning",
      cacheRate,
      reusableTokens,
      message: `stable prompt cache reuse fell below ${(minimumRate * 100).toFixed(0)}%`,
    };
  }
  return {
    status: "healthy",
    cacheRate,
    reusableTokens,
    message: "stable prompt cache reuse is healthy",
  };
}

function kibibytes(value: number) {
  return `${(value / 1024).toFixed(1)} KiB`;
}

export function formatPromptProfile(
  profile: PromptProfile,
  cache?: CacheGuardResult,
) {
  const lines = [
    `Last provider payload: ~${kibibytes(profile.totalBytes)}`,
    `System ${kibibytes(profile.systemBytes)} · tools ${kibibytes(profile.toolBytes)} (${profile.tools}) · conversation ${kibibytes(profile.conversationBytes)} (${profile.messages} messages) · other ${kibibytes(profile.otherBytes)}`,
  ];
  if (cache) {
    const rate =
      cache.cacheRate === null
        ? "unavailable"
        : `${(cache.cacheRate * 100).toFixed(1)}%`;
    lines.push(
      `Cache ${rate} across ${cache.reusableTokens.toLocaleString()} reusable tokens · ${cache.message}`,
    );
  }
  return lines.join("\n");
}
