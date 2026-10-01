import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesKey } from "@earendil-works/pi-tui";

if (process.argv[2] === "--receive") {
  const output = process.argv[3];
  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[>4;2m");
  await writeFile(`${output}.ready`, "ready");
  process.stdin.once("data", async (data) => {
    await writeFile(`${output}.tmp`, data);
    await rename(`${output}.tmp`, output);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000);
} else {
  const directory = await mkdtemp(join(tmpdir(), "pi-composer-keys-"));
  const socket = join(directory, "tmux.sock");
  const output = join(directory, "input");
  const tmux = (...args) => {
    const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const waitFor = async (path) => {
    for (let i = 0; i < 100; i++) {
      try { return await readFile(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${path}`);
  };
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "probe", "-x", "80", "-y", "24",
      [process.execPath, fileURLToPath(import.meta.url), "--receive", output].map(quote).join(" "));
    tmux("set-option", "-s", "extended-keys", "on");
    const version = tmux("-V").match(/(\d+)\.(\d+)/);
    if (version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 5))) {
      tmux("set-option", "-s", "extended-keys-format", "csi-u");
    }
    await waitFor(`${output}.ready`);
    tmux("send-keys", "-t", "probe", "S-Enter");
    const input = await waitFor(output);
    assert.equal(matchesKey(input.toString(), "shift+enter"), true, `Shift+Enter arrived as ${input.toString("hex")}`);
    console.log(`${tmux("-V").trim()}: Shift+Enter reaches Pi as ${input.toString("hex")}`);
  } finally {
    spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    await rm(directory, { recursive: true, force: true });
  }
}
