import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectMultiplexer, sendKeys, type SplitTarget } from "./multiplexer.ts";

function withEnv(isolate: () => void): void {
  const saved = {
    HERDR_ENV: process.env.HERDR_ENV,
    TMUX: process.env.TMUX,
    CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
  };
  try {
    isolate();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("detectMultiplexer reports the documented precedence", () => {
  withEnv(() => {
    delete process.env.HERDR_ENV;
    delete process.env.TMUX;
    delete process.env.CMUX_SOCKET_PATH;
    assert.equal(detectMultiplexer(), null);

    process.env.TMUX = "in-a-tmux-pane,1,0";
    assert.equal(detectMultiplexer(), "tmux");

    process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
    assert.equal(detectMultiplexer(), "tmux");

    delete process.env.TMUX;
    assert.equal(detectMultiplexer(), "cmux");

    process.env.HERDR_ENV = "1";
    assert.equal(detectMultiplexer(), "herder");
  });
});

test("sendKeys stays silent when no multiplexer is active", () => {
  withEnv(() => {
    delete process.env.HERDR_ENV;
    delete process.env.TMUX;
    delete process.env.CMUX_SOCKET_PATH;
    assert.doesNotThrow(() =>
      sendKeys({ type: "split", id: "%0" }, "echo should-never-run"),
    );
  });
});

test("sendKeys delivers text through a real tmux server", (t) => {
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("tmux not available");
  const tmuxPath = spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout.trim();

  const socket = `mux-test-${process.pid}-${Date.now()}`;
  const binDir = join(tmpdir(), `mux-test-bin-${process.pid}`);
  const savedPath = process.env.PATH;
  const savedTmux = process.env.TMUX;

  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "tmux"),
    `#!/bin/sh\nexec ${tmuxPath} -L ${socket} "$@"\n`,
  );
  chmodSync(join(binDir, "tmux"), 0o755);
  process.env.PATH = `${binDir}:${savedPath}`;
  process.env.TMUX = `/tmp/tmux-${userInfo().uid}/${socket},1,0`;

  const capture = () =>
    execFileSync(tmuxPath, ["-L", socket, "capture-pane", "-p", "-t", paneId], {
      encoding: "utf8",
    });
  const captureUntil = (marker: string) => {
    const deadline = Date.now() + 5_000;
    let text = "";
    while (Date.now() < deadline) {
      text = capture();
      if (text.includes(marker)) return text;
      execFileSync("sleep", ["0.1"]);
    }
    return text;
  };

  let paneId = "%0";
  try {
    execFileSync(tmuxPath, [
      "-L", socket, "new-session", "-d", "-x", "160", "-y", "50",
    ]);
    paneId = execFileSync(tmuxPath, [
      "-L", socket, "list-panes", "-F", "#{pane_id}",
    ], { encoding: "utf8" }).trim();
    const target: SplitTarget = { type: "split", id: paneId };

    sendKeys(target, "echo MUX_TEST_SHORT_OK");
    const afterShort = captureUntil("MUX_TEST_SHORT_OK");
    assert.equal(
      afterShort.includes("MUX_TEST_SHORT_OK"),
      true,
      `short text never reached the pane. Captured:\n${afterShort}`,
    );

    sendKeys(target, "echo MUX_TEST_LONG_OK_" + "x".repeat(900));
    const afterLong = captureUntil("MUX_TEST_LONG_OK_");
    assert.equal(
      afterLong.includes("MUX_TEST_LONG_OK_"),
      true,
      `long text never executed in the pane. Captured:\n${afterLong}`,
    );

    const handoffEntries = readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith("pi-handoff-"),
    );
    assert.equal(
      handoffEntries.length > 0,
      true,
      "long send left no handoff directory behind",
    );
    for (const entry of handoffEntries) {
      const entryPath = join(tmpdir(), entry);
      if (statSync(entryPath).isDirectory()) {
        assert.equal(
          statSync(entryPath).mode & 0o777,
          0o700,
          `handoff dir ${entry} is not owner-private`,
        );
      } else {
        assert.fail(`handoff artifact ${entry} is a root-level file, not a private dir`);
      }
    }

    const marker = join(tmpdir(), `mux-test-pwned-${process.pid}`);
    rmSync(marker, { force: true });
    assert.throws(() =>
      sendKeys(
        { type: "split", id: `${paneId}' ; touch ${marker}` },
        "echo injection",
      ),
    );
    assert.equal(
      existsSync(marker),
      false,
      "a pane id with shell metacharacters executed a shell command",
    );
  } finally {
    try {
      execFileSync(tmuxPath, ["-L", socket, "kill-server"]);
    } catch {}
    process.env.PATH = savedPath;
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    rmSync(binDir, { recursive: true, force: true });
    for (const entry of readdirSync(tmpdir())) {
      if (entry.startsWith("pi-handoff-")) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
    }
  }
});
