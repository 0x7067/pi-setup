import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCacheGuard,
  formatPromptProfile,
  profileProviderPayload,
} from "./src/prompt-profile.ts";

test("profiles OpenAI payload sections without retaining content", () => {
  const profile = profileProviderPayload({
    model: "test-model",
    messages: [
      { role: "system", content: "system instructions" },
      { role: "user", content: "hello" },
    ],
    tools: [{ type: "function", function: { name: "read" } }],
    stream: true,
  });

  assert.ok(profile.totalBytes > profile.systemBytes);
  assert.ok(profile.systemBytes > 2);
  assert.ok(profile.conversationBytes > 2);
  assert.ok(profile.toolBytes > 2);
  assert.equal(profile.messages, 1);
  assert.equal(profile.tools, 1);
  assert.equal(profile.stableHash.length, 64);
});

test("stability ignores conversation growth but detects prompt and tool changes", () => {
  const initial = profileProviderPayload({
    model: "test-model",
    messages: [
      { role: "system", content: "stable" },
      { role: "user", content: "first" },
    ],
    tools: [{ name: "read" }],
  });
  const continued = profileProviderPayload({
    model: "test-model",
    messages: [
      { role: "system", content: "stable" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ],
    tools: [{ name: "read" }],
  });
  const changedTool = profileProviderPayload({
    model: "test-model",
    messages: [{ role: "system", content: "stable" }],
    tools: [{ name: "write" }],
  });
  const changedPrompt = profileProviderPayload({
    model: "test-model",
    messages: [{ role: "system", content: "changed" }],
    tools: [{ name: "read" }],
  });

  assert.equal(initial.stableHash, continued.stableHash);
  assert.notEqual(initial.stableHash, changedTool.stableHash);
  assert.notEqual(initial.stableHash, changedPrompt.stableHash);
});

test("stability includes cache-affinity fields", () => {
  const first = profileProviderPayload({
    model: "test-model",
    prompt_cache_key: "session-a",
    messages: [{ role: "system", content: "stable" }],
    tools: [],
  });
  const second = profileProviderPayload({
    model: "test-model",
    prompt_cache_key: "session-b",
    messages: [{ role: "system", content: "stable" }],
    tools: [],
  });
  assert.notEqual(first.stableHash, second.stableHash);
});

test("profiles Anthropic root system prompts", () => {
  const profile = profileProviderPayload({
    model: "test-model",
    system: [{ type: "text", text: "instructions" }],
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  });

  assert.ok(profile.systemBytes > 2);
  assert.equal(profile.messages, 1);
  assert.equal(profile.tools, 0);
});

test("profiles Responses and Google payload shapes", () => {
  const responses = profileProviderPayload({
    model: "responses-model",
    instructions: "system",
    input: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", name: "read" }],
  });
  assert.equal(responses.messages, 1);
  assert.equal(responses.tools, 1);
  assert.ok(responses.systemBytes > 2);

  const google = profileProviderPayload({
    model: "google-model",
    systemInstruction: { parts: [{ text: "system" }] },
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    tools: [],
  });
  assert.equal(google.messages, 1);
  assert.equal(google.tools, 0);
  assert.ok(google.systemBytes > 2);
});

test("profile reports contain no prompt content and count UTF-8 bytes", () => {
  const secret = "never-print-this-🔐";
  const profile = profileProviderPayload({
    model: "test",
    messages: [{ role: "system", content: secret }],
    tools: [],
  });
  const report = formatPromptProfile(profile);
  assert.doesNotMatch(report, /never-print-this/);
  assert.ok(profile.totalBytes > JSON.stringify({}).length);
  assert.ok(profile.systemBytes > secret.length);
});

test("profiles large multimodal strings without serializing them into the report", () => {
  const image = "A".repeat(2 * 1024 * 1024);
  const profile = profileProviderPayload({
    model: "vision",
    messages: [
      { role: "system", content: "stable" },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image}` },
          },
        ],
      },
    ],
    tools: [],
  });
  assert.ok(profile.totalBytes > 2 * 1024 * 1024);
  assert.ok(profile.conversationBytes > 2 * 1024 * 1024);
  assert.doesNotMatch(formatPromptProfile(profile), /AAAAA/);
});

test("cache guard warns only for large stable warm misses", () => {
  const usage = { input: 10_000, cacheRead: 0 };
  assert.equal(
    evaluateCacheGuard(usage, {
      hadPriorRequest: false,
      stablePayload: true,
      supportsCache: true,
    }).status,
    "cold",
  );
  assert.equal(
    evaluateCacheGuard(usage, {
      hadPriorRequest: true,
      stablePayload: false,
      supportsCache: true,
    }).status,
    "changed",
  );
  assert.equal(
    evaluateCacheGuard(
      { input: 1000, cacheRead: 0 },
      {
        hadPriorRequest: true,
        stablePayload: true,
        supportsCache: true,
      },
    ).status,
    "small",
  );
  assert.equal(
    evaluateCacheGuard(usage, {
      hadPriorRequest: true,
      stablePayload: true,
      supportsCache: false,
    }).status,
    "unsupported",
  );
  assert.equal(
    evaluateCacheGuard(usage, {
      hadPriorRequest: true,
      stablePayload: true,
      supportsCache: true,
    }).status,
    "warning",
  );
});

test("cache guard accepts high reuse and accounts for reported writes", () => {
  const healthy = evaluateCacheGuard(
    { input: 58, cacheRead: 11_648 },
    {
      hadPriorRequest: true,
      stablePayload: true,
      supportsCache: true,
    },
  );
  assert.equal(healthy.status, "healthy");
  assert.ok((healthy.cacheRate ?? 0) > 0.99);

  const write = evaluateCacheGuard(
    {
      input: 76,
      cacheRead: 8941,
      cacheWrite: 76,
      cacheWriteReported: true,
    },
    {
      hadPriorRequest: true,
      stablePayload: true,
      supportsCache: true,
    },
  );
  assert.equal(write.status, "healthy");
  assert.equal(write.reusableTokens, 9093);
});

test("cache guard normalizes malformed usage instead of emitting NaN", () => {
  const result = evaluateCacheGuard(
    { input: Number.NaN, cacheRead: Number.POSITIVE_INFINITY },
    {
      hadPriorRequest: true,
      stablePayload: true,
      supportsCache: true,
    },
  );
  assert.equal(result.status, "small");
  assert.equal(result.reusableTokens, 0);
  assert.equal(result.cacheRate, null);
});

test("formats a compact prompt and cache report", () => {
  const profile = profileProviderPayload({
    model: "test-model",
    messages: [{ role: "system", content: "stable" }],
    tools: [],
  });
  const cache = evaluateCacheGuard(
    { input: 58, cacheRead: 11_648 },
    {
      hadPriorRequest: true,
      stablePayload: true,
      supportsCache: true,
    },
  );
  const output = formatPromptProfile(profile, cache);
  assert.match(output, /Last provider payload:/);
  assert.match(output, /tools .* \(0\)/);
  assert.match(output, /Cache 99\.5%/);
});
