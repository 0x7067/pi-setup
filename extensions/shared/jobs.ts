import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface JobSnapshot {
  id: string;
  kind: "agent" | "terminal";
  title: string;
  status: "running" | "done" | "failed" | "cancelled";
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  model?: string;
  /** Exit code, when the process exited with one. */
  exitCode?: number;
  /** Signal name, when the process was killed by a signal. */
  signal?: string;
  /** Bounded error / spawn / kill-escalation text. */
  errorText?: string;
  /** Why this job failed or was cancelled, for the UI. */
  reason?: string;
}

export interface JobSource {
  id: string;
  list(): readonly JobSnapshot[];
  subscribe(listener: () => void): () => void;
  inspect(id: string, ctx: ExtensionCommandContext): Promise<void>;
  /** UI cancellation preserves the manager's completion notification to the model. */
  cancel(id: string): void;
}

const REGISTER = "setup:jobs:register";
const REMOVE = "setup:jobs:remove";
const DISCOVER = "setup:jobs:discover";

/** Sources belong to the Pi event bus, so child sessions never share a registry. */
export function publishJobSource(pi: Pick<ExtensionAPI, "events">, source: JobSource) {
  const publish = () => pi.events.emit(REGISTER, source);
  const unsubscribe = pi.events.on(DISCOVER, publish);
  publish();
  return () => {
    unsubscribe();
    pi.events.emit(REMOVE, source);
  };
}

function isJobSource(value: unknown): value is JobSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<JobSource>;
  return typeof source.id === "string" && typeof source.list === "function"
    && typeof source.subscribe === "function" && typeof source.inspect === "function"
    && typeof source.cancel === "function";
}

export function observeJobSources(pi: Pick<ExtensionAPI, "events">, changed: () => void) {
  const sources = new Map<string, { source: JobSource; unsubscribe: () => void }>();
  const offRegister = pi.events.on(REGISTER, (value: unknown) => {
    if (!isJobSource(value)) return;
    const previous = sources.get(value.id);
    if (previous?.source === value) return;
    previous?.unsubscribe();
    sources.set(value.id, { source: value, unsubscribe: value.subscribe(changed) });
    changed();
  });
  const offRemove = pi.events.on(REMOVE, (value: unknown) => {
    if (!isJobSource(value)) return;
    const existing = sources.get(value.id);
    if (existing?.source !== value) return;
    existing.unsubscribe();
    sources.delete(value.id);
    changed();
  });
  return {
    discover() { pi.events.emit(DISCOVER, undefined); },
    list() {
      return [...sources.values()].flatMap(({ source }) => source.list().map((job) => ({ source, job })))
        .sort((a, b) => Number(b.job.status === "running") - Number(a.job.status === "running") || b.job.startedAt - a.job.startedAt);
    },
    dispose() {
      offRegister();
      offRemove();
      for (const { unsubscribe } of sources.values()) unsubscribe();
      sources.clear();
    },
  };
}

export function summarizeJobs(jobs: readonly JobSnapshot[]) {
  const running = jobs.filter((job) => job.status === "running").length;
  const done = jobs.filter((job) => job.status === "done").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const cancelled = jobs.filter((job) => job.status === "cancelled").length;
  const total = jobs.length;
  return { running, done, failed, cancelled, total };
}
