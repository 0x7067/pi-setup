import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observeJobSources, publishJobSource, summarizeJobs, type JobSnapshot, type JobSource } from "./jobs.ts";

function bus(): Pick<ExtensionAPI, "events"> {
  const emitter = new EventEmitter();
  return { events: {
    emit: (name, value) => { emitter.emit(name, value); },
    on: (name, listener) => { emitter.on(name, listener); return () => { emitter.off(name, listener); }; },
  } };
}

function source(id: string, kind: JobSnapshot["kind"]) {
  let job: JobSnapshot = { id: "1", kind, title: id, cwd: "/tmp", status: "running", startedAt: 1 };
  const listeners = new Set<() => void>();
  const result: JobSource = {
    id,
    list: () => [job],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    inspect: async () => {},
    cancel: async () => { job = { ...job, status: "cancelled" }; for (const listener of listeners) listener(); },
  };
  return { result, listeners };
}

function staticSource(id: string, kind: JobSnapshot["kind"], job: JobSnapshot) {
  const listeners = new Set<() => void>();
  const result: JobSource = {
    id,
    list: () => [job],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    inspect: async () => {},
    cancel: async () => {},
  };
  return { result, listeners };
}

test("jobs discover sources loaded earlier, combine both kinds, and observe cancellation", async () => {
  const pi = bus();
  const agents = source("agents", "agent");
  const terminals = source("terminals", "terminal");
  const removeAgent = publishJobSource(pi, agents.result);
  let changes = 0;
  const registry = observeJobSources(pi, () => { changes++; });
  registry.discover();
  const removeTerminal = publishJobSource(pi, terminals.result);
  registry.discover();
  assert.equal(registry.list().length, 2);
  assert.equal(agents.listeners.size, 1);
  assert.equal(summarizeJobs(registry.list().map(({ job }) => job)).running, 2);
  const before = changes;
  await terminals.result.cancel("1");
  assert.ok(changes > before);
  const summary = summarizeJobs(registry.list().map(({ job }) => job));
  assert.equal(summary.running, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.failed, 0);
  removeAgent();
  assert.equal(registry.list().length, 1);
  removeTerminal();
  registry.dispose();
  assert.equal(agents.listeners.size + terminals.listeners.size, 0);
});

test("summarize counts cancelled jobs apart from failures, whatever ended them", () => {
  const pi = bus();
  const failedExit: JobSnapshot = { id: "1", kind: "terminal", title: "exit", cwd: "/tmp", status: "failed", startedAt: 1, finishedAt: 2, exitCode: 1 };
  const failedSignal: JobSnapshot = { id: "2", kind: "terminal", title: "signal", cwd: "/tmp", status: "failed", startedAt: 1, finishedAt: 2, signal: "SIGTERM" };
  const cancelled: JobSnapshot = { id: "3", kind: "agent", title: "aborted", cwd: "/tmp", status: "cancelled", startedAt: 1, finishedAt: 2, reason: "Run was aborted" };
  const registry = observeJobSources(pi, () => {});
  publishJobSource(pi, staticSource("exit", "terminal", failedExit).result);
  publishJobSource(pi, staticSource("signal", "terminal", failedSignal).result);
  publishJobSource(pi, staticSource("aborted", "agent", cancelled).result);
  registry.discover();
  const summary = summarizeJobs(registry.list().map(({ job }) => job));
  assert.equal(summary.failed, 2);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.total, 3);
  registry.dispose();
});

test("job registries are session-local and retiring an old source cannot remove its replacement", () => {
  const parent = bus();
  const child = bus();
  const parentRegistry = observeJobSources(parent, () => {});
  const childRegistry = observeJobSources(child, () => {});
  const old = source("agents", "agent");
  const replacement = source("agents", "agent");
  const removeOld = publishJobSource(parent, old.result);
  const removeNew = publishJobSource(parent, replacement.result);
  assert.equal(old.listeners.size, 0);
  removeOld();
  assert.equal(parentRegistry.list()[0]?.source, replacement.result);
  childRegistry.discover();
  assert.deepEqual(childRegistry.list(), []);
  parentRegistry.dispose();
  assert.equal(replacement.listeners.size, 0);
  removeNew();
  childRegistry.dispose();
});
